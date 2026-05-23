// State
let currentMode = 'all';
let allTabs = [];
let selectedTabIds = new Set();
let isProcessing = false;
let settingsOpen = false;

// DOM Elements
const modeButtons = document.querySelectorAll('.mode-btn');
const tabListSection = document.getElementById('tabListSection');
const tabListEl = document.getElementById('tabList');
const selectAllBtn = document.getElementById('selectAll');
const selectNoneBtn = document.getElementById('selectNone');
const settingsToggle = document.getElementById('settingsToggle');
const settingsContent = document.getElementById('settingsContent');
const toggleIcon = document.getElementById('toggleIcon');
const convertBtn = document.getElementById('convertBtn');
const btnText = document.getElementById('btnText');
const btnIcon = document.getElementById('btnIcon');
const statusArea = document.getElementById('statusArea');
const progressFill = document.getElementById('progressFill');
const statusText = document.getElementById('statusText');
const resultArea = document.getElementById('resultArea');
const resultIcon = document.getElementById('resultIcon');
const resultTextEl = document.getElementById('resultText');
const resetBtn = document.getElementById('resetBtn');

// Init
document.addEventListener('DOMContentLoaded', async () => {
  await loadTabs();
  setupEventListeners();
  loadSettings();
});

async function loadTabs() {
  allTabs = await chrome.tabs.query({ currentWindow: true });
  // Pre-select all tabs
  allTabs.forEach(tab => selectedTabIds.add(tab.id));
  renderTabList();
}

function renderTabList() {
  tabListEl.innerHTML = '';
  allTabs.forEach(tab => {
    const item = document.createElement('div');
    item.className = 'tab-item' + (selectedTabIds.has(tab.id) ? ' checked' : '');
    item.dataset.tabId = tab.id;

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'tab-checkbox';
    checkbox.checked = selectedTabIds.has(tab.id);

    const favicon = document.createElement('img');
    favicon.className = 'tab-favicon';
    favicon.src = tab.favIconUrl || 'icons/icon16.png';
    favicon.onerror = () => { favicon.src = 'icons/icon16.png'; };

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || tab.url;
    title.title = tab.url;

    item.appendChild(checkbox);
    item.appendChild(favicon);
    item.appendChild(title);

    item.addEventListener('click', (e) => {
      if (e.target !== checkbox) checkbox.checked = !checkbox.checked;
      toggleTabSelection(tab.id, checkbox.checked);
    });

    tabListEl.appendChild(item);
  });
}

function toggleTabSelection(tabId, checked) {
  if (checked) {
    selectedTabIds.add(tabId);
  } else {
    selectedTabIds.delete(tabId);
  }
  // Update item class
  const item = tabListEl.querySelector(`[data-tab-id="${tabId}"]`);
  if (item) item.className = 'tab-item' + (checked ? ' checked' : '');
  updateConvertButton();
}

function setupEventListeners() {
  // Mode buttons
  modeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      currentMode = btn.dataset.mode;
      modeButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      if (currentMode === 'selected') {
        tabListSection.classList.remove('hidden');
      } else {
        tabListSection.classList.add('hidden');
      }
      updateConvertButton();
    });
  });

  // Select All / None
  selectAllBtn.addEventListener('click', () => {
    allTabs.forEach(tab => selectedTabIds.add(tab.id));
    renderTabList();
    updateConvertButton();
  });

  selectNoneBtn.addEventListener('click', () => {
    selectedTabIds.clear();
    renderTabList();
    updateConvertButton();
  });

  // Settings toggle
  settingsToggle.addEventListener('click', () => {
    settingsOpen = !settingsOpen;
    settingsContent.className = 'settings-content' + (settingsOpen ? ' open' : '');
    toggleIcon.className = 'toggle-icon' + (settingsOpen ? ' open' : '');
  });

  // Convert button
  convertBtn.addEventListener('click', startConversion);

  // Reset button
  resetBtn.addEventListener('click', resetUI);

  // Save settings on change
  ['outputFormat', 'paperSize', 'orientation', 'printBackground', 'margins', 'delaySeconds'].forEach(id => {
    document.getElementById(id)?.addEventListener('change', saveSettings);
  });
}

function updateConvertButton() {
  if (currentMode === 'selected' && selectedTabIds.size === 0) {
    convertBtn.disabled = true;
    btnText.textContent = 'タブを選択してください';
  } else {
    convertBtn.disabled = false;
    const count = getTargetTabCount();
    btnText.textContent = `${count}タブ → PDF に変換`;
  }
}

function getTargetTabCount() {
  if (currentMode === 'all') return allTabs.length;
  if (currentMode === 'current') return 1;
  return selectedTabIds.size;
}

function getTargetTabs() {
  if (currentMode === 'all') return allTabs;
  if (currentMode === 'current') return allTabs.filter(t => t.active);
  return allTabs.filter(t => selectedTabIds.has(t.id));
}

function getSettings() {
  return {
    outputFormat: document.getElementById('outputFormat').value,
    paperSize: document.getElementById('paperSize').value,
    orientation: document.getElementById('orientation').value,
    printBackground: document.getElementById('printBackground').checked,
    margins: document.getElementById('margins').value,
    delaySeconds: parseFloat(document.getElementById('delaySeconds').value) || 2,
  };
}

function saveSettings() {
  chrome.storage.local.set({ pdfSettings: getSettings() });
}

function loadSettings() {
  chrome.storage.local.get('pdfSettings', ({ pdfSettings }) => {
    if (!pdfSettings) return;
    const s = pdfSettings;
    if (s.outputFormat) document.getElementById('outputFormat').value = s.outputFormat;
    if (s.paperSize) document.getElementById('paperSize').value = s.paperSize;
    if (s.orientation) document.getElementById('orientation').value = s.orientation;
    if (s.printBackground !== undefined) document.getElementById('printBackground').checked = s.printBackground;
    if (s.margins) document.getElementById('margins').value = s.margins;
    if (s.delaySeconds !== undefined) document.getElementById('delaySeconds').value = s.delaySeconds;
  });
  updateConvertButton();
}

async function startConversion() {
  if (isProcessing) return;
  isProcessing = true;

  const tabs = getTargetTabs();
  const settings = getSettings();

  // UI: show status
  convertBtn.disabled = true;
  btnIcon.textContent = '⏳';
  btnText.textContent = '処理中...';
  statusArea.classList.remove('hidden');
  resultArea.classList.add('hidden');

  try {
    // Send message to background
    const response = await chrome.runtime.sendMessage({
      action: 'convertTabsToPDF',
      tabs: tabs.map(t => ({ id: t.id, url: t.url, title: t.title })),
      settings
    });

    if (response.success) {
      showResult(true, `${response.count}件のPDFをダウンロードしました`, tabs.length);
    } else {
      showResult(false, response.error || 'エラーが発生しました');
    }
  } catch (err) {
    showResult(false, err.message || 'エラーが発生しました');
  }
}

// Listen for progress updates from background
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'progress') {
    const pct = Math.round((msg.current / msg.total) * 100);
    progressFill.style.width = pct + '%';
    statusText.textContent = `変換中... (${msg.current}/${msg.total}) ${msg.title || ''}`;
  }
});

function showResult(success, message, count) {
  isProcessing = false;
  statusArea.classList.add('hidden');
  resultArea.classList.remove('hidden');
  resultIcon.textContent = success ? '✅' : '❌';
  resultTextEl.textContent = message;
  convertBtn.classList.add('hidden');
}

function resetUI() {
  isProcessing = false;
  convertBtn.disabled = false;
  convertBtn.classList.remove('hidden');
  btnIcon.textContent = '📥';
  btnText.textContent = `${getTargetTabCount()}タブ → PDF に変換`;
  statusArea.classList.add('hidden');
  resultArea.classList.add('hidden');
  progressFill.style.width = '0%';
}
