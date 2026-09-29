#!/usr/bin/env python3
"""
Local Print Agent — Windows Edition
A lightweight HTTP server that accepts PDF print jobs and sends them
to your Windows printers via PowerShell / CUPS.

Endpoints:
  GET  /health    — Check if the agent is running
  GET  /printers  — List available printers
  POST /print     — Submit a PDF for printing

Usage:
  pythonw print-agent-windows.py           # runs on default port 9191 (no console window)
  pythonw print-agent-windows.py 9999      # runs on custom port
"""

import http.server
import json
import os
import subprocess
import tempfile
import urllib.parse
from email import message_from_bytes

HOST = "127.0.0.1"
DEFAULT_PORT = 9191


def _run_powershell(command, timeout=10):
    """Run a PowerShell command and return (stdout, stderr, returncode)."""
    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command", command],
        capture_output=True, text=True, timeout=timeout
    )
    return result.stdout.strip(), result.stderr.strip(), result.returncode


def get_printers():
    """Return list of available printers via PowerShell."""
    try:
        stdout, _, rc = _run_powershell(
            "Get-Printer | Select-Object -ExpandProperty Name | ConvertTo-Json -Compress"
        )
        if rc != 0 or not stdout:
            return []
        parsed = json.loads(stdout)
        if isinstance(parsed, str):
            return [parsed]
        if isinstance(parsed, list):
            return parsed
        return []
    except Exception:
        return []


def print_pdf(pdf_bytes, printer=None, copies=1, title="print-job"):
    """
    Send PDF bytes to a printer using PowerShell / ShellExecute.

    Strategy:
    1. Write PDF to a temp file.
    2. If a specific printer is requested, temporarily set it as the default,
       print, then restore the original default.
    3. Use Start-Process with -Verb Print to invoke the system PDF handler.
    """
    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp_path = f.name.replace("\\", "\\\\")

    try:
        if printer:
            # Escape the printer name for PowerShell
            safe_printer = printer.replace("'", "''")
            ps_script = f"""
$prevDefault = (Get-WmiObject -Class Win32_Printer | Where-Object {{ $_.Default -eq $true }}).Name
$target = Get-WmiObject -Class Win32_Printer -Filter "Name='{safe_printer}'"
if (-not $target) {{
    Write-Error "Printer not found: {safe_printer}"
    exit 1
}}
$target.SetDefaultPrinter() | Out-Null
for ($i = 1; $i -le {copies}; $i++) {{
    Start-Process -FilePath '{tmp_path}' -Verb Print -Wait
}}
if ($prevDefault) {{
    $prev = Get-WmiObject -Class Win32_Printer -Filter "Name='$prevDefault'"
    if ($prev) {{ $prev.SetDefaultPrinter() | Out-Null }}
}}
Write-Output "Sent {copies} copy/copies to {safe_printer}"
"""
        else:
            ps_script = f"""
for ($i = 1; $i -le {copies}; $i++) {{
    Start-Process -FilePath '{tmp_path}' -Verb Print -Wait
}}
Write-Output "Sent {copies} copy/copies to default printer"
"""

        stdout, stderr, rc = _run_powershell(ps_script, timeout=60)

        if rc != 0:
            return False, stderr or "Unknown error while printing"
        return True, stdout or "Job sent"

    finally:
        try:
            os.unlink(tmp_path.replace("\\\\", "\\"))
        except OSError:
            pass


class PrintAgentHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print(f"[Print Agent] {self.address_string()} — {format % args}", flush=True)

    def send_json(self, code, data):
        body = json.dumps(data, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/health":
            self.send_json(200, {"status": "ok", "service": "print-agent"})

        elif path == "/printers":
            printers = get_printers()
            self.send_json(200, {"printers": printers, "count": len(printers)})

        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        if path != "/print":
            self.send_json(404, {"error": "Not found"})
            return

        content_type = self.headers.get("Content-Type", "")
        content_length = int(self.headers.get("Content-Length", 0))

        if content_length == 0:
            self.send_json(400, {"error": "Empty request body"})
            return

        body = self.rfile.read(content_length)

        if "multipart/form-data" in content_type:
            self._handle_multipart(content_type, body)

        elif content_type.split(";")[0].strip() == "application/pdf":
            self._handle_raw_pdf(body)

        else:
            self.send_json(415, {
                "error": (
                    f"Unsupported Content-Type: '{content_type}'. "
                    "Use 'application/pdf' or 'multipart/form-data'."
                )
            })

    def _handle_raw_pdf(self, body):
        if not body.startswith(b"%PDF"):
            self.send_json(400, {"error": "Body does not look like a valid PDF"})
            return

        params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        printer = params.get("printer", [None])[0]
        title = params.get("title", ["print-job"])[0]
        try:
            copies = int(params.get("copies", ["1"])[0])
        except (ValueError, TypeError):
            copies = 1

        ok, msg = print_pdf(body, printer=printer, copies=copies, title=title)
        if ok:
            self.send_json(200, {"status": "queued", "message": msg})
        else:
            self.send_json(500, {"error": msg})

    def _handle_multipart(self, content_type, body):
        msg_bytes = f"Content-Type: {content_type}\r\n\r\n".encode() + body
        msg = message_from_bytes(msg_bytes)

        pdf_bytes = None
        printer = None
        copies = 1
        title = "print-job"

        payload = msg.get_payload()
        if not isinstance(payload, list):
            self.send_json(400, {"error": "Could not parse multipart body"})
            return

        for part in payload:
            disp = part.get("Content-Disposition", "")
            if 'name="file"' in disp:
                pdf_bytes = part.get_payload(decode=True)
            elif 'name="printer"' in disp:
                raw = part.get_payload(decode=False)
                if isinstance(raw, str):
                    printer = raw.strip()
            elif 'name="copies"' in disp:
                try:
                    copies = int(part.get_payload(decode=False).strip())
                except (ValueError, TypeError, AttributeError):
                    copies = 1
            elif 'name="title"' in disp:
                raw = part.get_payload(decode=False)
                if isinstance(raw, str):
                    title = raw.strip()

        if not pdf_bytes:
            self.send_json(400, {"error": "No 'file' field found in multipart body"})
            return

        if not pdf_bytes.startswith(b"%PDF"):
            self.send_json(400, {"error": "Uploaded file does not look like a valid PDF"})
            return

        ok, result_msg = print_pdf(pdf_bytes, printer=printer or None, copies=copies, title=title)
        if ok:
            self.send_json(200, {"status": "queued", "message": result_msg})
        else:
            self.send_json(500, {"error": result_msg})


if __name__ == "__main__":
    import sys

    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"[Print Agent] Invalid port '{sys.argv[1]}', using default {DEFAULT_PORT}", flush=True)

    print(f"[Print Agent] Starting on http://{HOST}:{port}", flush=True)
    print(f"[Print Agent] Endpoints:", flush=True)
    print(f"  GET  http://{HOST}:{port}/health", flush=True)
    print(f"  GET  http://{HOST}:{port}/printers", flush=True)
    print(f"  POST http://{HOST}:{port}/print", flush=True)
    print(f"[Print Agent] Press Ctrl+C to stop\n", flush=True)

    server = http.server.HTTPServer((HOST, port), PrintAgentHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Print Agent] Stopped.", flush=True)
