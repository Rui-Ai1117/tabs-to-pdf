// Background Service Worker — Tabs to PDF
// Uses Chrome Debugger API (Page.printToPDF) with proper error handling

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'convertTabsToPDF') {
    handleConversion(msg.tabs, msg.settings)
      .then(result => sendResponse(result))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});

// ─── Main conversion loop ────────────────────────────────────────────────────

async function handleConversion(tabs, settings) {
  const total = tabs.length;
  let successCount = 0;
  const pdfDataList = [];

  const paperSizeMap = {
    A4:     { width: 8.27,  height: 11.69 },
    Letter: { width: 8.5,   height: 11    },
    A3:     { width: 11.69, height: 16.54 },
  };
  const paper = paperSizeMap[settings.paperSize] || paperSizeMap.A4;
  const isLandscape = settings.orientation === 'landscape';

  const marginMap = {
    default: { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 },
    none:    { top: 0,   bottom: 0,   left: 0,   right: 0   },
    minimum: { top: 0.1, bottom: 0.1, left: 0.1, right: 0.1 },
  };
  const margin = marginMap[settings.margins] || marginMap.default;

  const printOptions = {
    landscape:        isLandscape,
    printBackground:  settings.printBackground,
    paperWidth:       isLandscape ? paper.height : paper.width,
    paperHeight:      isLandscape ? paper.width  : paper.height,
    marginTop:        margin.top,
    marginBottom:     margin.bottom,
    marginLeft:       margin.left,
    marginRight:      margin.right,
    transferMode:     'ReturnAsBase64',  // Required in newer Chrome versions
  };

  for (let i = 0; i < tabs.length; i++) {
    const tab = tabs[i];

    // Progress notification
    try {
      await chrome.runtime.sendMessage({
        action: 'progress',
        current: i + 1,
        total,
        title: (tab.title || tab.url).substring(0, 30),
      });
    } catch (_) {}

    // Skip internal Chrome pages
    if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      console.warn(`Skipping internal page: ${tab.url}`);
      continue;
    }

    try {
      await ensureTabLoaded(tab.id);

      if (i > 0 && settings.delaySeconds > 0) {
        await delay(settings.delaySeconds * 1000);
      }

      const pdfBase64 = await printTabToPDF(tab.id, printOptions);

      if (settings.outputFormat === 'separate') {
        const filename = sanitizeFilename(tab.title || `tab_${i + 1}`) + '.pdf';
        await downloadPDF(pdfBase64, filename);
      } else {
        pdfDataList.push({ data: pdfBase64, title: tab.title || `Tab ${i + 1}` });
      }

      successCount++;
    } catch (err) {
      console.error(`Failed to convert "${tab.title}":`, err);
    }
  }

  // Merged mode: download all collected PDFs
  if (settings.outputFormat === 'merged' && pdfDataList.length > 0) {
    for (let i = 0; i < pdfDataList.length; i++) {
      const fname = `merged_${String(i + 1).padStart(3, '0')}_${sanitizeFilename(pdfDataList[i].title)}.pdf`;
      await downloadPDF(pdfDataList[i].data, fname);
    }
  }

  return {
    success: successCount > 0,
    count:   successCount,
    error:   successCount === 0
      ? '変換できるタブがありませんでした（chrome:// などの内部ページは変換不可）'
      : null,
  };
}

// ─── Chrome Debugger PDF API ─────────────────────────────────────────────────

function printTabToPDF(tabId, options) {
  return new Promise((resolve, reject) => {
    const target = { tabId };

    function onDetach(src, reason) {
      if (src.tabId === tabId) {
        chrome.debugger.onDetach.removeListener(onDetach);
      }
    }
    chrome.debugger.onDetach.addListener(onDetach);

    chrome.debugger.attach(target, '1.3', () => {
      if (chrome.runtime.lastError) {
        chrome.debugger.onDetach.removeListener(onDetach);
        return reject(new Error('attach failed: ' + chrome.runtime.lastError.message));
      }

      // Enable Page domain first (required for some sites)
      chrome.debugger.sendCommand(target, 'Page.enable', {}, () => {
        if (chrome.runtime.lastError) {
          // Non-fatal, continue
        }

        chrome.debugger.sendCommand(target, 'Page.printToPDF', options, (result) => {
          const cmdErr = chrome.runtime.lastError;

          chrome.debugger.detach(target, () => {
            chrome.debugger.onDetach.removeListener(onDetach);
          });

          if (cmdErr) {
            return reject(new Error('printToPDF failed: ' + cmdErr.message));
          }
          if (!result || !result.data) {
            return reject(new Error('No PDF data returned'));
          }

          resolve(result.data);
        });
      });
    });
  });
}

// ─── Tab loading helper ───────────────────────────────────────────────────────

function ensureTabLoaded(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        return reject(new Error(chrome.runtime.lastError.message));
      }
      if (tab.status === 'complete') return resolve(tab);

      const listener = (id, changeInfo) => {
        if (id === tabId && changeInfo.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }, 15000);
    });
  });
}

// ─── Download helper ──────────────────────────────────────────────────────────

function downloadPDF(base64Data, filename) {
  return new Promise((resolve) => {
    if (!base64Data) return resolve();
    const url = `data:application/pdf;base64,${base64Data}`;
    chrome.downloads.download(
      { url, filename: `TabsToPDF/${filename}`, saveAs: false },
      () => {
        if (chrome.runtime.lastError) {
          console.error('Download error:', chrome.runtime.lastError.message);
        }
        resolve();
      }
    );
  });
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_').substring(0, 80);
}
