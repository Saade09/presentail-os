# Presentail Order Capture — Chrome Extension

Capture structured order data from the [Toters Merchant Admin](https://merchant.totersapp.com) page with one click. Copy as JSON, copy as a human-readable summary, or export as CSV — entirely in the browser, no server calls.

---

## File list

```
extensions/presentail-order-capture/
├── manifest.json   Chrome Manifest V3 declaration
├── content.js      DOM extraction script (injected into the Toters page)
├── popup.html      Extension popup layout
├── popup.css       Popup styles (no external resources)
├── popup.js        Popup logic — capture, render, copy, export
└── README.md       This file
```

---

## How to load in Chrome (Developer Mode)

### Option A — Load directly from this Replit project

1. In Replit, open the **Files** panel in the left sidebar.
2. Right-click the `extensions/presentail-order-capture/` folder and choose **Download**.
   Replit will download the folder as a `.zip` file.
3. Unzip the file to a permanent folder on your computer
   (e.g. `~/extensions/presentail-order-capture/`).

### Option B — Clone / copy the folder manually

Copy the six files above into a local folder on your machine.

---

### Load as an unpacked extension

1. Open Chrome and navigate to `chrome://extensions`.
2. Enable **Developer mode** using the toggle in the top-right corner.
3. Click **"Load unpacked"**.
4. Select the folder that contains `manifest.json`
   (e.g. `~/extensions/presentail-order-capture/`).
5. The **Presentail Order Capture** extension will appear in your extension list and its icon will be pinned to the Chrome toolbar.

---

## How to use

1. Log into [merchant.totersapp.com](https://merchant.totersapp.com) and open any **order detail page**.
2. Click the **Presentail Order Capture** icon in the Chrome toolbar.
3. In the popup, click **Capture Order**.
4. The extension injects a content script into the page, extracts all visible order fields, and renders them in structured sections:
   - **Order Info** — order number, status, placed time, prepare-by time, shopper/tracking status
   - **Customer** — name, phone, unique customer ID
   - **Store & Delivery** — store/branch name, delivery address
   - **Totals** — currency, items total, discount, final total
   - **Items** — quantity, product name, options/add-ons, price per item and line total
   - **Notes** — any visible special instructions or card message (shown only when present)

### Action buttons

| Button | What it does |
|--------|-------------|
| **Copy JSON** | Copies the full structured object to the clipboard as pretty-printed JSON |
| **Copy Summary** | Copies a human-readable plain-text summary to the clipboard |
| **Export CSV** | Downloads a `.csv` file with one row for the order; line items are serialised into a single `lineItems` column separated by `|` |
| **Clear** | Resets the popup and discards the captured data |

---

## Permissions used

| Permission | Why |
|------------|-----|
| `activeTab` | Read the currently active tab's URL and inject a script into it |
| `scripting` | Inject `content.js` into the Toters page on demand |
| `clipboardWrite` | Write captured data to the clipboard |
| `host_permissions: https://merchant.totersapp.com/*` | Restrict injection to the Toters Merchant Admin domain only |

The extension **never** makes network requests, **never** sends data to any server, and **never** stores data beyond the current popup session.

---

## Troubleshooting

**"Please open an order page on merchant.totersapp.com"**
→ The active tab must be on `merchant.totersapp.com`. Navigate to an order detail page first, then click the extension icon.

**"Script injection failed"**
→ Refresh the Toters page and try again. If the problem persists, reload the extension at `chrome://extensions`.

**Fields show "—"**
→ The selectors didn't match the current page layout. The content script uses label-text fallback matching, which is resilient to class-name changes, but significant page redesigns may need selector updates in `content.js`.

---

## Updating the extension

After editing any file, go to `chrome://extensions`, find **Presentail Order Capture**, and click the **refresh** icon (↻) to reload the unpacked extension. Then reload the Toters tab before capturing again.
