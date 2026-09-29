// ─── Defaults (mirrored from content.js for the Advanced panel) ───────────────

const DEFAULT_SELECTORS = {
  orderNumber:      '[data-testid="order-number"], .order-number, .order-id',
  orderStatus:      '[data-testid="order-status"], .order-status, .status-badge',
  storeName:        '[data-testid="store-name"], .store-name, .branch-name',
  customerName:     '[data-testid="customer-name"], .customer-name',
  customerPhone:    '[data-testid="customer-phone"], .customer-phone',
  customerUniqueId: '[data-testid="customer-id"], .customer-id, .customer-uid',
  deliveryAddress:  '[data-testid="delivery-address"], .delivery-address, .address-text',
  placedAt:         '[data-testid="placed-at"], .placed-at, .order-time',
  prepareBy:        '[data-testid="prepare-by"], .prepare-by, .preparation-time',
  shopperStatus:    '[data-testid="shopper-status"], .shopper-status, .tracking-status',
  itemsTotal:       '[data-testid="items-total"], .items-total, .subtotal',
  discount:         '[data-testid="discount"], .discount-amount, .discount',
  finalTotal:       '[data-testid="final-total"], .final-total, .order-total, .total-amount',
  currency:         '[data-testid="currency"], .currency',
  lineItems:        '[data-testid="line-item"], .line-item, .order-item, .cart-item',
  notes:            '[data-testid="order-notes"], .order-notes, .special-instructions, .card-message',
};

const DEFAULT_LABEL_HINTS = {
  orderNumber:      'order number, order #, order id',
  orderStatus:      'status',
  storeName:        'store, branch',
  customerName:     'customer name, customer',
  customerPhone:    'phone, mobile',
  customerUniqueId: 'customer id, user id, uid',
  deliveryAddress:  'address, delivery address, location',
  placedAt:         'placed, order time, created',
  prepareBy:        'prepare by, preparation, ready by',
  shopperStatus:    'shopper, tracking, driver',
  itemsTotal:       'items total, subtotal, sub total',
  discount:         'discount',
  finalTotal:       'total, grand total, final total',
  currency:         '',
  lineItems:        '',
  notes:            'notes, instructions, card message, message',
};

const FIELD_LABELS = {
  orderNumber:      'Order Number',
  orderStatus:      'Order Status',
  storeName:        'Store Name',
  customerName:     'Customer Name',
  customerPhone:    'Customer Phone',
  customerUniqueId: 'Customer UID',
  deliveryAddress:  'Delivery Address',
  placedAt:         'Placed At',
  prepareBy:        'Prepare By',
  shopperStatus:    'Shopper Status',
  itemsTotal:       'Items Total',
  discount:         'Discount',
  finalTotal:       'Final Total',
  currency:         'Currency',
  lineItems:        'Line Items',
  notes:            'Notes',
};

const STORAGE_KEY = 'toters_selectors';

// ─── State ────────────────────────────────────────────────────────────────────

let capturedData = null;

// ─── DOM references ───────────────────────────────────────────────────────────

const captureBtn        = document.getElementById('captureBtn');
const statusMsg         = document.getElementById('statusMsg');
const preview           = document.getElementById('preview');
const emptyState        = document.getElementById('emptyState');
const copyJsonBtn       = document.getElementById('copyJsonBtn');
const copySummaryBtn    = document.getElementById('copySummaryBtn');
const exportCsvBtn      = document.getElementById('exportCsvBtn');
const clearBtn          = document.getElementById('clearBtn');
const sendBtn           = document.getElementById('sendBtn');
const sendStatus        = document.getElementById('sendStatus');
const settingsToggleBtn = document.getElementById('settingsToggleBtn');
const settingsSection   = document.getElementById('settingsSection');
const apiUrlInput       = document.getElementById('apiUrlInput');
const apiKeyInput       = document.getElementById('apiKeyInput');
const saveSettingsBtn   = document.getElementById('saveSettingsBtn');
const clearSettingsBtn  = document.getElementById('clearSettingsBtn');
const settingsSaveStatus = document.getElementById('settingsSaveStatus');
const domainPermissionHint = document.getElementById('domainPermissionHint');
const advancedToggleBtn = document.getElementById('advancedToggleBtn');
const advancedPanel     = document.getElementById('advancedPanel');
const selectorList      = document.getElementById('selectorList');
const saveSelectorsBtn  = document.getElementById('saveSelectorsBtn');
const resetSelectorsBtn = document.getElementById('resetSelectorsBtn');
const healthPanel       = document.getElementById('healthPanel');
const healthGrid        = document.getElementById('healthGrid');
const healthSummary     = document.getElementById('healthSummary');

// Section field containers
const fieldOrder    = document.getElementById('fieldOrder');
const fieldCustomer = document.getElementById('fieldCustomer');
const fieldDelivery = document.getElementById('fieldDelivery');
const fieldTotals   = document.getElementById('fieldTotals');
const itemsList     = document.getElementById('itemsList');
const itemCount     = document.getElementById('itemCount');
const sectionNotes  = document.getElementById('sectionNotes');
const notesText     = document.getElementById('notesText');

// ─── Permission helpers ────────────────────────────────────────────────────────

function isBuiltInHost(hostname) {
  return (
    hostname.endsWith('.replit.app') ||
    hostname === 'replit.app' ||
    hostname.endsWith('.replit.dev') ||
    hostname === 'replit.dev'
  );
}

function needsPermissionRequest(urlString) {
  try {
    const { hostname } = new URL(urlString);
    return !isBuiltInHost(hostname);
  } catch {
    return false;
  }
}

function requestHostPermission(urlString) {
  return new Promise((resolve) => {
    let origin;
    try {
      origin = new URL(urlString).origin;
    } catch {
      resolve({ granted: false, error: 'Invalid URL' });
      return;
    }
    chrome.permissions.request({ origins: [origin + '/*'] }, (granted) => {
      if (chrome.runtime.lastError) {
        resolve({ granted: false, error: chrome.runtime.lastError.message });
      } else {
        resolve({ granted });
      }
    });
  });
}

// ─── Settings storage ─────────────────────────────────────────────────────────

function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.get(['presentailApiUrl', 'presentailApiKey'], (result) => {
      resolve({
        apiUrl: result.presentailApiUrl || '',
        apiKey: result.presentailApiKey || '',
      });
    });
  });
}

function saveSettings(apiUrl, apiKey) {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ presentailApiUrl: apiUrl, presentailApiKey: apiKey }, resolve);
  });
}

function clearSettings() {
  return new Promise((resolve) => {
    chrome.storage.sync.remove(['presentailApiUrl', 'presentailApiKey'], resolve);
  });
}

// ─── Status helpers ───────────────────────────────────────────────────────────

function setStatus(msg, type) {
  statusMsg.textContent = msg;
  statusMsg.className = 'status-msg ' + (type || '');
}

function clearStatus() {
  statusMsg.textContent = '';
  statusMsg.className = 'status-msg';
}

function setSendStatus(msg, type) {
  sendStatus.textContent = msg;
  sendStatus.className = 'send-status ' + (type || '');
  sendStatus.classList.remove('hidden');
}

function clearSendStatus() {
  sendStatus.textContent = '';
  sendStatus.className = 'send-status hidden';
}

// ─── Advanced panel ───────────────────────────────────────────────────────────

/**
 * Build the selector + label-hint editor inside #selectorList.
 * saved = { selectors: {...}, labelHints: {...} }
 */
function buildSelectorForm(saved) {
  const savedSels   = (saved && saved.selectors)   || {};
  const savedHints  = (saved && saved.labelHints)  || {};

  selectorList.innerHTML = '';

  // ── CSS Selectors section ──
  const selHeading = document.createElement('div');
  selHeading.className = 'advanced-subsection-title';
  selHeading.textContent = 'CSS Selectors';
  selectorList.appendChild(selHeading);

  for (const key of Object.keys(DEFAULT_SELECTORS)) {
    const row = document.createElement('div');
    row.className = 'selector-row';

    const label = document.createElement('label');
    label.className = 'selector-label';
    label.htmlFor = `sel-${key}`;
    label.textContent = FIELD_LABELS[key] || key;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `sel-${key}`;
    input.className = 'selector-input';
    input.dataset.key = key;
    input.dataset.group = 'selector';
    input.value = savedSels[key] || DEFAULT_SELECTORS[key];
    input.placeholder = DEFAULT_SELECTORS[key];

    if (savedSels[key] && savedSels[key] !== DEFAULT_SELECTORS[key]) {
      input.classList.add('is-custom');
    }

    row.appendChild(label);
    row.appendChild(input);
    selectorList.appendChild(row);
  }

  // ── Label Hints section ──
  const hintHeading = document.createElement('div');
  hintHeading.className = 'advanced-subsection-title';
  hintHeading.style.marginTop = '10px';
  hintHeading.textContent = 'Label Text Hints (comma-separated)';
  selectorList.appendChild(hintHeading);

  const hintNote = document.createElement('div');
  hintNote.className = 'advanced-subsection-note';
  hintNote.textContent = 'Fallback: searched when CSS selectors find nothing.';
  selectorList.appendChild(hintNote);

  for (const key of Object.keys(DEFAULT_LABEL_HINTS)) {
    if (DEFAULT_LABEL_HINTS[key] === '' && !savedHints[key]) continue; // skip empty-by-default, unediterd fields

    const row = document.createElement('div');
    row.className = 'selector-row';

    const label = document.createElement('label');
    label.className = 'selector-label';
    label.htmlFor = `hint-${key}`;
    label.textContent = FIELD_LABELS[key] || key;

    const input = document.createElement('input');
    input.type = 'text';
    input.id = `hint-${key}`;
    input.className = 'selector-input';
    input.dataset.key = key;
    input.dataset.group = 'labelHint';
    input.value = savedHints[key] !== undefined ? savedHints[key] : DEFAULT_LABEL_HINTS[key];
    input.placeholder = DEFAULT_LABEL_HINTS[key] || '(none)';

    if (savedHints[key] !== undefined && savedHints[key] !== DEFAULT_LABEL_HINTS[key]) {
      input.classList.add('is-custom');
    }

    row.appendChild(label);
    row.appendChild(input);
    selectorList.appendChild(row);
  }
}

function openAdvancedPanel() {
  chrome.storage.sync.get(STORAGE_KEY, (stored) => {
    buildSelectorForm(stored[STORAGE_KEY] || {});
    advancedPanel.classList.remove('hidden');
    advancedToggleBtn.classList.add('active');
  });
}

function closeAdvancedPanel() {
  advancedPanel.classList.add('hidden');
  advancedToggleBtn.classList.remove('active');
}

advancedToggleBtn.addEventListener('click', () => {
  if (advancedPanel.classList.contains('hidden')) {
    openAdvancedPanel();
  } else {
    closeAdvancedPanel();
  }
});

saveSelectorsBtn.addEventListener('click', () => {
  const selectorOverrides  = {};
  const labelHintOverrides = {};

  const inputs = selectorList.querySelectorAll('.selector-input');
  for (const input of inputs) {
    const key = input.dataset.key;
    const val = input.value.trim();

    if (input.dataset.group === 'selector') {
      if (val && val !== DEFAULT_SELECTORS[key]) {
        selectorOverrides[key] = val;
      }
    } else if (input.dataset.group === 'labelHint') {
      if (val !== DEFAULT_LABEL_HINTS[key]) {
        labelHintOverrides[key] = val;
      }
    }
  }

  const toSave = { selectors: selectorOverrides, labelHints: labelHintOverrides };
  chrome.storage.sync.set({ [STORAGE_KEY]: toSave }, () => {
    setStatus('Selectors saved!', 'success');
    buildSelectorForm(toSave);
    setTimeout(clearStatus, 2000);
  });
});

resetSelectorsBtn.addEventListener('click', () => {
  chrome.storage.sync.remove(STORAGE_KEY, () => {
    buildSelectorForm({});
    setStatus('Selectors reset to defaults.', 'success');
    setTimeout(clearStatus, 2000);
  });
});

// ─── Health check display ─────────────────────────────────────────────────────

function renderHealth(health) {
  if (!health) {
    healthPanel.classList.add('hidden');
    return;
  }

  const keys    = Object.keys(DEFAULT_SELECTORS);
  const matched = keys.filter(k => health[k] === 'matched').length;
  const total   = keys.length;
  const allGood = matched === total;

  healthSummary.textContent = `${matched}/${total} matched`;
  healthSummary.className = 'health-summary ' + (allGood ? 'all-good' : 'has-misses');

  healthGrid.innerHTML = '';
  for (const key of keys) {
    const status = health[key] || 'empty';
    const chip = document.createElement('span');
    chip.className = `health-chip health-${status}`;
    chip.title = `${FIELD_LABELS[key] || key}: ${status}`;
    chip.textContent = FIELD_LABELS[key] || key;
    healthGrid.appendChild(chip);
  }

  healthPanel.classList.remove('hidden');
}

// ─── Render helpers ───────────────────────────────────────────────────────────

function renderFields(container, fields) {
  container.innerHTML = '';
  for (const [label, value] of fields) {
    const dt = document.createElement('dt');
    dt.textContent = label;

    const dd = document.createElement('dd');
    if (value) {
      dd.textContent = value;
    } else {
      dd.textContent = '—';
      dd.classList.add('empty');
    }
    container.appendChild(dt);
    container.appendChild(dd);
  }
}

function renderItems(items) {
  itemsList.innerHTML = '';
  itemCount.textContent = items.length;

  if (!items.length) {
    const p = document.createElement('p');
    p.className = 'no-items';
    p.textContent = 'No line items detected.';
    itemsList.appendChild(p);
    return;
  }

  for (const item of items) {
    const card = document.createElement('div');
    card.className = 'item-card';

    const header = document.createElement('div');
    header.className = 'item-header';

    if (item.qty) {
      const qtyEl = document.createElement('span');
      qtyEl.className = 'item-qty';
      qtyEl.textContent = item.qty;
      header.appendChild(qtyEl);
    }

    const nameEl = document.createElement('span');
    nameEl.className = 'item-name';
    nameEl.textContent = item.name || '(unnamed)';
    header.appendChild(nameEl);

    if (item.total || item.price) {
      const priceEl = document.createElement('span');
      priceEl.className = 'item-price';
      priceEl.textContent = item.total || item.price;
      header.appendChild(priceEl);
    }

    card.appendChild(header);

    if (item.options) {
      const optEl = document.createElement('div');
      optEl.className = 'item-options';
      optEl.textContent = item.options;
      card.appendChild(optEl);
    }

    itemsList.appendChild(card);
  }
}

function renderPreview(data) {
  renderFields(fieldOrder, [
    ['Order #',         data.order.orderNumber],
    ['Status',          data.order.orderStatus],
    ['Placed',          data.order.placedAt],
    ['Prepare by',      data.order.prepareBy],
    ['Shopper status',  data.order.shopperStatus],
    ['Platform',        data.platform],
  ]);

  renderFields(fieldCustomer, [
    ['Name',  data.customer.customerName],
    ['Phone', data.customer.customerPhone],
    ['UID',   data.customer.customerUniqueId],
  ]);

  renderFields(fieldDelivery, [
    ['Store',   data.storeAndDelivery.storeName],
    ['Address', data.storeAndDelivery.deliveryAddress],
  ]);

  renderFields(fieldTotals, [
    ['Currency',    data.totals.currency],
    ['Items total', data.totals.itemsTotal],
    ['Discount',    data.totals.discount],
    ['Final total', data.totals.finalTotal],
  ]);

  renderItems(data.lineItems);

  if (data.notes) {
    notesText.textContent = data.notes;
    sectionNotes.style.display = '';
  } else {
    sectionNotes.style.display = 'none';
  }

  preview.classList.remove('hidden');
  emptyState.style.display = 'none';
}

// ─── Settings panel ───────────────────────────────────────────────────────────

function updateDomainHint() {
  const val = apiUrlInput.value.trim();
  if (val && needsPermissionRequest(val)) {
    domainPermissionHint.classList.remove('hidden');
  } else {
    domainPermissionHint.classList.add('hidden');
  }
}

async function initSettings() {
  const { apiUrl, apiKey } = await loadSettings();
  if (apiUrl) apiUrlInput.value = apiUrl;
  if (apiKey) apiKeyInput.value = apiKey;

  updateDomainHint();

  // Auto-open settings if not configured yet
  if (!apiKey) {
    settingsSection.classList.remove('hidden');
  }
}

apiUrlInput.addEventListener('input', updateDomainHint);

settingsToggleBtn.addEventListener('click', () => {
  settingsSection.classList.toggle('hidden');
});

saveSettingsBtn.addEventListener('click', async () => {
  const apiUrl = apiUrlInput.value.trim().replace(/\/+$/, '');
  const apiKey = apiKeyInput.value.trim();

  if (!apiUrl) {
    settingsSaveStatus.textContent = 'API URL is required.';
    settingsSaveStatus.className = 'settings-save-status error';
    return;
  }
  if (!apiKey.startsWith('pk_live_')) {
    settingsSaveStatus.textContent = 'API key must start with pk_live_';
    settingsSaveStatus.className = 'settings-save-status error';
    return;
  }

  if (needsPermissionRequest(apiUrl)) {
    settingsSaveStatus.textContent = 'Requesting host permission…';
    settingsSaveStatus.className = 'settings-save-status';
    const { granted, error } = await requestHostPermission(apiUrl);
    if (!granted) {
      settingsSaveStatus.textContent = error
        ? `Permission denied: ${error}`
        : 'Permission denied. Grant access to this domain and try again.';
      settingsSaveStatus.className = 'settings-save-status error';
      return;
    }
    domainPermissionHint.classList.add('hidden');
  }

  await saveSettings(apiUrl, apiKey);
  settingsSaveStatus.textContent = 'Saved!';
  settingsSaveStatus.className = 'settings-save-status success';
  setTimeout(() => {
    settingsSaveStatus.textContent = '';
    settingsSection.classList.add('hidden');
  }, 1200);
});

clearSettingsBtn.addEventListener('click', async () => {
  await clearSettings();
  apiUrlInput.value = '';
  apiKeyInput.value = '';
  updateDomainHint();
  settingsSaveStatus.textContent = 'Cleared.';
  settingsSaveStatus.className = 'settings-save-status';
  setTimeout(() => { settingsSaveStatus.textContent = ''; }, 1200);
});

// ─── Capture ──────────────────────────────────────────────────────────────────

captureBtn.addEventListener('click', async () => {
  captureBtn.disabled = true;
  setStatus('Capturing…', 'info');
  clearSendStatus();

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch (err) {
    setStatus('Could not access tab: ' + err.message, 'error');
    captureBtn.disabled = false;
    return;
  }

  if (!tab || !tab.url) {
    setStatus('No active tab found.', 'error');
    captureBtn.disabled = false;
    return;
  }

  if (!tab.url.includes('merchant.totersapp.com')) {
    setStatus('Please open an order page on merchant.totersapp.com.', 'error');
    captureBtn.disabled = false;
    return;
  }

  // Inject the content script then send it a message
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (err) {
    setStatus('Script injection failed: ' + err.message, 'error');
    captureBtn.disabled = false;
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: 'captureOrder' }, (response) => {
    captureBtn.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus('Extension error: ' + chrome.runtime.lastError.message, 'error');
      return;
    }

    if (!response || !response.success) {
      setStatus('Capture failed: ' + (response ? response.error : 'no response'), 'error');
      return;
    }

    capturedData = response.data;
    renderPreview(capturedData);
    renderHealth(response.health || null);
    setStatus('Order captured!', 'success');
  });
});

// ─── Send to Presentail ───────────────────────────────────────────────────────

sendBtn.addEventListener('click', async () => {
  if (!capturedData) return;

  const { apiUrl, apiKey } = await loadSettings();

  if (!apiUrl || !apiKey) {
    settingsSection.classList.remove('hidden');
    setSendStatus('Please configure your Presentail API URL and key first.', 'error');
    return;
  }

  sendBtn.disabled = true;
  setSendStatus('Sending…', 'info');

  try {
    const endpoint = `${apiUrl}/api/orders/import-toters`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(capturedData),
    });

    let body;
    try {
      body = await response.json();
    } catch {
      body = null;
    }

    if (response.status === 401) {
      setSendStatus('Invalid API key. Check your settings.', 'error');
    } else if (response.ok) {
      const orderId = body?.order_id ?? '';
      const isNew = response.status === 201;
      setSendStatus(
        isNew
          ? `Order created! ID: ${orderId}`
          : `Already imported (ID: ${orderId})`,
        'success',
      );
    } else {
      const errMsg = body?.error ?? `HTTP ${response.status}`;
      setSendStatus(`Failed: ${errMsg}`, 'error');
    }
  } catch (err) {
    setSendStatus('Network error: ' + err.message, 'error');
  } finally {
    sendBtn.disabled = false;
  }
});

// ─── Copy JSON ────────────────────────────────────────────────────────────────

copyJsonBtn.addEventListener('click', async () => {
  if (!capturedData) return;
  try {
    await navigator.clipboard.writeText(JSON.stringify(capturedData, null, 2));
    setStatus('JSON copied!', 'success');
  } catch (err) {
    setStatus('Copy failed: ' + err.message, 'error');
  }
});

// ─── Copy Summary ─────────────────────────────────────────────────────────────

copySummaryBtn.addEventListener('click', async () => {
  if (!capturedData) return;

  const d = capturedData;
  const lines = [
    `===== Presentail Order Capture =====`,
    `Platform:       ${d.platform}`,
    `Captured at:    ${d.capturedAt}`,
    `Page URL:       ${d.pageUrl}`,
    ``,
    `----- Order Info -----`,
    `Order #:        ${d.order.orderNumber || '—'}`,
    `Status:         ${d.order.orderStatus || '—'}`,
    `Placed:         ${d.order.placedAt || '—'}`,
    `Prepare by:     ${d.order.prepareBy || '—'}`,
    `Shopper status: ${d.order.shopperStatus || '—'}`,
    ``,
    `----- Customer -----`,
    `Name:           ${d.customer.customerName || '—'}`,
    `Phone:          ${d.customer.customerPhone || '—'}`,
    `UID:            ${d.customer.customerUniqueId || '—'}`,
    ``,
    `----- Store & Delivery -----`,
    `Store:          ${d.storeAndDelivery.storeName || '—'}`,
    `Address:        ${d.storeAndDelivery.deliveryAddress || '—'}`,
    ``,
    `----- Totals -----`,
    `Currency:       ${d.totals.currency || '—'}`,
    `Items total:    ${d.totals.itemsTotal || '—'}`,
    `Discount:       ${d.totals.discount || '—'}`,
    `Final total:    ${d.totals.finalTotal || '—'}`,
  ];

  if (d.lineItems && d.lineItems.length) {
    lines.push('');
    lines.push(`----- Items (${d.lineItems.length}) -----`);
    for (const item of d.lineItems) {
      lines.push(
        `  [${item.qty || '?'}x] ${item.name || '(unnamed)'}` +
        (item.options ? ` — ${item.options}` : '') +
        (item.total || item.price ? `  ${item.total || item.price}` : '')
      );
    }
  }

  if (d.notes) {
    lines.push('');
    lines.push(`----- Notes -----`);
    lines.push(d.notes);
  }

  lines.push('');
  lines.push(`=====================================`);

  try {
    await navigator.clipboard.writeText(lines.join('\n'));
    setStatus('Summary copied!', 'success');
  } catch (err) {
    setStatus('Copy failed: ' + err.message, 'error');
  }
});

// ─── Export CSV ───────────────────────────────────────────────────────────────

function csvCell(value) {
  const str = (value == null ? '' : String(value)).replace(/"/g, '""');
  return `"${str}"`;
}

exportCsvBtn.addEventListener('click', () => {
  if (!capturedData) return;

  const d = capturedData;
  const headers = [
    'platform', 'capturedAt', 'pageUrl',
    'orderNumber', 'orderStatus', 'placedAt', 'prepareBy', 'shopperStatus',
    'customerName', 'customerPhone', 'customerUniqueId',
    'storeName', 'deliveryAddress',
    'currency', 'itemsTotal', 'discount', 'finalTotal',
    'lineItems', 'notes',
  ];

  const lineItemsSummary = (d.lineItems || [])
    .map(item => `${item.qty || '?'}x ${item.name || ''}${item.options ? ' (' + item.options + ')' : ''} ${item.total || item.price || ''}`.trim())
    .join(' | ');

  const row = [
    d.platform,
    d.capturedAt,
    d.pageUrl,
    d.order.orderNumber,
    d.order.orderStatus,
    d.order.placedAt,
    d.order.prepareBy,
    d.order.shopperStatus,
    d.customer.customerName,
    d.customer.customerPhone,
    d.customer.customerUniqueId,
    d.storeAndDelivery.storeName,
    d.storeAndDelivery.deliveryAddress,
    d.totals.currency,
    d.totals.itemsTotal,
    d.totals.discount,
    d.totals.finalTotal,
    lineItemsSummary,
    d.notes,
  ];

  const csvContent = [
    headers.map(csvCell).join(','),
    row.map(csvCell).join(','),
  ].join('\r\n');

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const orderNum = (d.order.orderNumber || 'order').replace(/[^a-zA-Z0-9_-]/g, '_');
  a.download = `presentail-order-${orderNum}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  setStatus('CSV exported!', 'success');
});

// ─── Clear ────────────────────────────────────────────────────────────────────

clearBtn.addEventListener('click', () => {
  capturedData = null;
  preview.classList.add('hidden');
  healthPanel.classList.add('hidden');
  emptyState.style.display = '';
  clearStatus();
  clearSendStatus();
});

// ─── Init ─────────────────────────────────────────────────────────────────────

initSettings();
