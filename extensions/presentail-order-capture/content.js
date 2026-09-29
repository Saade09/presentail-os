// ─── Default selector configuration ──────────────────────────────────────────
// Adjust these if the Toters Merchant Admin DOM structure changes.
// Users can override both CSS selectors and label hints from the popup's
// Advanced panel; overrides are stored in chrome.storage.sync under
// STORAGE_KEY and merged at capture time.
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

// Label-text hints used as fallback when CSS selectors don't match.
// Each value is a comma-separated list of label strings to try via findByLabel().
// Empty string means no label-text fallback for that field.
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

const STORAGE_KEY = 'toters_selectors';

// ─── Utility helpers ──────────────────────────────────────────────────────────

function norm(text) {
  return (text || '').replace(/\s+/g, ' ').trim();
}

/**
 * Try multiple CSS selectors and return the first non-empty text found.
 */
function queryText(selectorString) {
  const selectors = selectorString.split(',').map(s => s.trim());
  for (const sel of selectors) {
    try {
      const el = document.querySelector(sel);
      if (el) {
        const text = norm(el.textContent);
        if (text) return text;
      }
    } catch (_) {}
  }
  return '';
}

/**
 * Find an element whose visible label text contains the given string and return
 * the adjacent value element's text. Handles label→sibling, dt→dd, and
 * th→td patterns commonly used in order detail tables.
 */
function findByLabel(labelText) {
  const lower = labelText.toLowerCase();

  // dt/dd pairs
  const dts = document.querySelectorAll('dt');
  for (const dt of dts) {
    if (norm(dt.textContent).toLowerCase().includes(lower)) {
      const dd = dt.nextElementSibling;
      if (dd && dd.tagName === 'DD') return norm(dd.textContent);
    }
  }

  // th/td pairs
  const ths = document.querySelectorAll('th');
  for (const th of ths) {
    if (norm(th.textContent).toLowerCase().includes(lower)) {
      const td = th.nextElementSibling;
      if (td && td.tagName === 'TD') return norm(td.textContent);
    }
  }

  // label + sibling / label[for] + input
  const labels = document.querySelectorAll('label, .label, .field-label, .detail-label');
  for (const label of labels) {
    if (norm(label.textContent).toLowerCase().includes(lower)) {
      const next = label.nextElementSibling;
      if (next) return norm(next.textContent);
      const parent = label.parentElement;
      if (parent) {
        const sibling = parent.nextElementSibling;
        if (sibling) return norm(sibling.textContent);
      }
    }
  }

  // Generic: any element whose text matches as a label
  const allEls = document.querySelectorAll('span, p, div, td, li');
  for (const el of allEls) {
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === Node.TEXT_NODE)
      .map(n => norm(n.textContent))
      .join(' ')
      .trim();
    if (directText.toLowerCase().includes(lower)) {
      const next = el.nextElementSibling;
      if (next) {
        const val = norm(next.textContent);
        if (val && !val.toLowerCase().includes(lower)) return val;
      }
    }
  }

  return '';
}

/**
 * Try each comma-separated label hint string via findByLabel(); return first match.
 */
function findByAnyLabel(hintsString) {
  if (!hintsString) return '';
  const hints = hintsString.split(',').map(s => s.trim()).filter(Boolean);
  for (const hint of hints) {
    const val = findByLabel(hint);
    if (val) return val;
  }
  return '';
}

/**
 * Extract structured line items from the DOM.
 * Tries testid/class selectors first, then falls back to table rows.
 */
function extractLineItems(lineItemSel) {
  const items = [];

  // Try explicit line-item containers from config
  const containers = document.querySelectorAll(lineItemSel);

  if (containers.length > 0) {
    for (const container of containers) {
      const qty = norm(
        (container.querySelector('[data-testid="item-qty"], .item-qty, .quantity') || {}).textContent
      ) || '';
      const name = norm(
        (container.querySelector('[data-testid="item-name"], .item-name, .product-name') || {}).textContent
      ) || norm(container.textContent).split('\n')[0];
      const options = norm(
        (container.querySelector('[data-testid="item-options"], .item-options, .addons, .modifiers') || {}).textContent
      ) || '';
      const price = norm(
        (container.querySelector('[data-testid="item-price"], .item-price, .unit-price') || {}).textContent
      ) || '';
      const total = norm(
        (container.querySelector('[data-testid="item-total"], .item-total, .line-total') || {}).textContent
      ) || '';

      if (name) {
        items.push({ qty, name, options, price, total });
      }
    }
    return items;
  }

  // Fallback: look for table rows that look like order items
  const rows = document.querySelectorAll('table tbody tr, .items-table tr');
  for (const row of rows) {
    const cells = Array.from(row.querySelectorAll('td')).map(td => norm(td.textContent));
    if (cells.length >= 2) {
      items.push({
        qty: cells[0] || '',
        name: cells[1] || '',
        options: cells[2] || '',
        price: cells[3] || '',
        total: cells[4] || '',
      });
    }
  }

  return items;
}

/**
 * Detect the currency from the page (look for common currency symbols / codes).
 */
function detectCurrency(selectors) {
  const explicit = queryText(selectors.currency);
  if (explicit) return explicit;

  const pageText = document.body.innerText || '';
  for (const code of ['AED', 'USD', 'LBP', 'SAR', 'KWD', 'BHD', 'QAR', 'OMR', 'JOD', 'EGP']) {
    if (pageText.includes(code)) return code;
  }
  if (pageText.includes('$')) return 'USD';
  if (pageText.includes('£')) return 'GBP';
  if (pageText.includes('€')) return 'EUR';
  return '';
}

// ─── Health check ─────────────────────────────────────────────────────────────

/**
 * For each selector field, report whether the selector matched a non-empty
 * element on the current page. Returns an object mapping field name →
 * 'matched' | 'empty' | 'error'.
 */
function runHealthCheck(selectors) {
  const health = {};
  for (const key of Object.keys(DEFAULT_SELECTORS)) {
    const sel = selectors[key] || DEFAULT_SELECTORS[key];
    if (key === 'lineItems') {
      try {
        health[key] = document.querySelectorAll(sel).length > 0 ? 'matched' : 'empty';
      } catch (_) {
        health[key] = 'error';
      }
    } else {
      try {
        health[key] = queryText(sel) ? 'matched' : 'empty';
      } catch (_) {
        health[key] = 'error';
      }
    }
  }
  return health;
}

// ─── Main capture function ────────────────────────────────────────────────────

function captureOrder(selectors, labelHints) {
  const orderNumber = queryText(selectors.orderNumber)
    || findByAnyLabel(labelHints.orderNumber);

  const orderStatus = queryText(selectors.orderStatus)
    || findByAnyLabel(labelHints.orderStatus);

  const storeName = queryText(selectors.storeName)
    || findByAnyLabel(labelHints.storeName);

  const customerName = queryText(selectors.customerName)
    || findByAnyLabel(labelHints.customerName);

  const customerPhone = queryText(selectors.customerPhone)
    || findByAnyLabel(labelHints.customerPhone);

  const customerUniqueId = queryText(selectors.customerUniqueId)
    || findByAnyLabel(labelHints.customerUniqueId);

  const deliveryAddress = queryText(selectors.deliveryAddress)
    || findByAnyLabel(labelHints.deliveryAddress);

  const placedAt = queryText(selectors.placedAt)
    || findByAnyLabel(labelHints.placedAt);

  const prepareBy = queryText(selectors.prepareBy)
    || findByAnyLabel(labelHints.prepareBy);

  const shopperStatus = queryText(selectors.shopperStatus)
    || findByAnyLabel(labelHints.shopperStatus);

  const itemsTotal = queryText(selectors.itemsTotal)
    || findByAnyLabel(labelHints.itemsTotal);

  const discount = queryText(selectors.discount)
    || findByAnyLabel(labelHints.discount);

  const finalTotal = queryText(selectors.finalTotal)
    || findByAnyLabel(labelHints.finalTotal);

  const currency = detectCurrency(selectors);

  const lineItems = extractLineItems(selectors.lineItems);

  const notes = queryText(selectors.notes)
    || findByAnyLabel(labelHints.notes);

  return {
    platform: 'Toters',
    capturedAt: new Date().toISOString(),
    pageUrl: window.location.href,
    order: {
      orderNumber,
      orderStatus,
      placedAt,
      prepareBy,
      shopperStatus,
    },
    customer: {
      customerName,
      customerUniqueId,
      customerPhone,
    },
    storeAndDelivery: {
      storeName,
      deliveryAddress,
    },
    totals: {
      currency,
      itemsTotal,
      discount,
      finalTotal,
    },
    lineItems,
    notes,
  };
}

// ─── Message listener ─────────────────────────────────────────────────────────

function loadConfig(callback) {
  chrome.storage.sync.get(STORAGE_KEY, (stored) => {
    const saved = stored[STORAGE_KEY] || {};
    const selectors  = { ...DEFAULT_SELECTORS,   ...(saved.selectors  || {}) };
    const labelHints = { ...DEFAULT_LABEL_HINTS, ...(saved.labelHints || {}) };
    callback(selectors, labelHints);
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'captureOrder') {
    loadConfig((selectors, labelHints) => {
      try {
        const data   = captureOrder(selectors, labelHints);
        const health = runHealthCheck(selectors);
        sendResponse({ success: true, data, health });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });
    return true; // keep channel open for async sendResponse
  }

  if (message.type === 'healthCheck') {
    loadConfig((selectors) => {
      try {
        const health = runHealthCheck(selectors);
        sendResponse({ success: true, health });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    });
    return true;
  }
});
