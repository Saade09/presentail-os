# Print Agent

A lightweight local background service for your Mac that accepts PDF print jobs over HTTP and sends them to any of your Mac's printers.

No third-party dependencies — uses Python 3 and macOS's built-in printing system (CUPS/`lp`).

---

## Files

| File | Purpose |
|------|---------|
| `print-agent.py` | The HTTP server |
| `com.local.print-agent.plist` | macOS LaunchAgent config (auto-start on login) |
| `setup.sh` | Install & start the agent |
| `uninstall.sh` | Stop & remove the agent |

---

## Installation

1. **Copy this folder** to a permanent location on your Mac (e.g. `~/Applications/print-agent/` or `~/tools/print-agent/`).  
   > Do not move the folder after installing — the LaunchAgent stores the exact path.

2. Open Terminal, navigate to the folder, and run:
   ```bash
   cd ~/Applications/print-agent   # or wherever you put it
   chmod +x setup.sh uninstall.sh
   ./setup.sh
   ```

3. That's it. The agent is now running and will start automatically at every login.

---

## API Reference

The agent listens on **`http://127.0.0.1:9191`** (localhost only — not accessible from other machines).

### `GET /health`
Check that the agent is running.
```bash
curl http://127.0.0.1:9191/health
```
```json
{ "status": "ok", "service": "print-agent" }
```

---

### `GET /printers`
List all printers available on your Mac.
```bash
curl http://127.0.0.1:9191/printers
```
```json
{ "printers": ["HP_LaserJet", "Brother_DCP"], "count": 2 }
```

---

### `POST /print`
Submit a PDF for printing.

**Option A — Raw PDF body (simplest):**
```bash
curl -X POST http://127.0.0.1:9191/print \
     -H "Content-Type: application/pdf" \
     --data-binary @/path/to/document.pdf
```

With options (printer name, copies, job title):
```bash
curl -X POST "http://127.0.0.1:9191/print?printer=HP_LaserJet&copies=2&title=Invoice" \
     -H "Content-Type: application/pdf" \
     --data-binary @/path/to/document.pdf
```

**Option B — Multipart form (useful for apps/scripts):**
```bash
curl -X POST http://127.0.0.1:9191/print \
     -F "file=@/path/to/document.pdf" \
     -F "printer=HP_LaserJet" \
     -F "copies=1" \
     -F "title=My Document"
```

**Response (success):**
```json
{ "status": "queued", "message": "request id is printer-123" }
```

**Response (error):**
```json
{ "error": "printer 'Foo' not found" }
```

#### Query / form parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `printer` | system default | Printer name (from `/printers`) |
| `copies` | `1` | Number of copies |
| `title` | `print-job` | Job title shown in the print queue |

---

## Logs

```bash
tail -f /tmp/print-agent.log        # stdout
tail -f /tmp/print-agent.error.log  # stderr / errors
```

---

## Custom Port

To run on a different port, edit `com.local.print-agent.plist` and add the port number as a second argument before running `setup.sh`:

```xml
<array>
    <string>/usr/bin/python3</string>
    <string>INSTALL_PATH/print-agent.py</string>
    <string>9999</string>   <!-- your custom port -->
</array>
```

Then re-run `./setup.sh`.

---

## Uninstall

```bash
./uninstall.sh
```

This stops the agent and removes the LaunchAgent. The script files in the folder are left intact.

---

## Requirements

- macOS 10.15 (Catalina) or later
- Python 3 (pre-installed on all modern Macs at `/usr/bin/python3`)
- At least one printer configured in System Settings → Printers & Scanners
