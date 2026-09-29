#!/usr/bin/env python3
"""
Local Print Agent
A lightweight HTTP server that accepts PDF print jobs and sends them
to your Mac's printers via CUPS (the lp command).

Endpoints:
  GET  /health    — Check if the agent is running
  GET  /printers  — List available printers
  POST /print     — Submit a PDF for printing

Usage:
  python3 print-agent.py           # runs on default port 9191
  python3 print-agent.py 9999      # runs on custom port
"""

import hashlib
import http.server
import json
import os
import platform
import socket
import subprocess
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from email import message_from_bytes
from pathlib import Path

HOST = "127.0.0.1"
DEFAULT_PORT = 9191
AGENT_VERSION = "1.0.0"
HEARTBEAT_INTERVAL_SEC = 60
JOB_POLL_INTERVAL_SEC = 10
CONFIG_DIR = Path.home() / ".print-agent"
CONFIG_PATH = CONFIG_DIR / "config.json"
DEFAULT_API_URL = "https://print.presentail.com"

# Origins permitted to pair this agent. These are the only websites that
# can call /configure, and the only api_url values we'll talk to.
# Extra origins can be added at runtime via the PRINT_AGENT_TRUSTED_ORIGINS
# env var (comma-separated) — used when developing against a non-prod
# dashboard.
TRUSTED_ORIGINS = {"https://print.presentail.com"}
for _extra in os.environ.get("PRINT_AGENT_TRUSTED_ORIGINS", "").split(","):
    _extra = _extra.strip().rstrip("/")
    if _extra:
        TRUSTED_ORIGINS.add(_extra)


def _norm(o):
    return (o or "").strip().rstrip("/")


def is_origin_allowed(origin):
    return _norm(origin) in {_norm(o) for o in TRUSTED_ORIGINS}


def is_api_url_allowed(api_url):
    return _norm(api_url) in {_norm(o) for o in TRUSTED_ORIGINS}

# Shared mutable config — updated when /configure is hit so the heartbeat
# loop picks up new credentials without restarting the process.
_config_lock = threading.Lock()
_current_config = {"api_key": None, "api_url": None, "machine_id": None}


def write_config(api_key, api_url):
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(
        json.dumps({"api_key": api_key, "api_url": api_url}, indent=2) + "\n"
    )
    try:
        os.chmod(CONFIG_PATH, 0o600)
    except OSError:
        pass


def load_config():
    """Load API key + URL from ~/.print-agent/config.json. Returns None if not configured."""
    try:
        with open(CONFIG_PATH, "r") as f:
            cfg = json.load(f)
        if cfg.get("api_key") and cfg.get("api_url"):
            return cfg
    except (OSError, json.JSONDecodeError):
        pass
    return None


def get_machine_id():
    """Stable per-machine identifier. Hardware UUID on macOS, machine-id on Linux,
    or a fallback hash of hostname + platform."""
    try:
        if platform.system() == "Darwin":
            out = subprocess.run(
                ["ioreg", "-rd1", "-c", "IOPlatformExpertDevice"],
                capture_output=True, text=True, timeout=5,
            ).stdout
            for line in out.split("\n"):
                if "IOPlatformUUID" in line:
                    parts = line.split('"')
                    if len(parts) >= 4:
                        return parts[-2]
        elif platform.system() == "Linux":
            for p in ("/etc/machine-id", "/var/lib/dbus/machine-id"):
                if os.path.exists(p):
                    return open(p).read().strip()
    except Exception:
        pass
    fingerprint = f"{socket.gethostname()}|{platform.system()}|{platform.node()}"
    return hashlib.sha256(fingerprint.encode()).hexdigest()[:32]


def get_device_name():
    """Friendly display name for this device — host name preferred."""
    try:
        if platform.system() == "Darwin":
            out = subprocess.run(
                ["scutil", "--get", "ComputerName"],
                capture_output=True, text=True, timeout=5,
            ).stdout.strip()
            if out:
                return out
    except Exception:
        pass
    return socket.gethostname() or "Unknown device"


def get_os_string():
    sys_name = platform.system()
    if sys_name == "Darwin":
        return f"macOS {platform.mac_ver()[0]}"
    if sys_name == "Linux":
        return f"Linux {platform.release()}"
    if sys_name == "Windows":
        return f"Windows {platform.release()}"
    return sys_name or "Unknown"


def cloud_get(url, api_key, timeout=10):
    """GET a cloud endpoint with Bearer auth.
    Returns (status_code_or_None, parsed_json_or_err_str)."""
    req = urllib.request.Request(
        url,
        headers={
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"PrintAgent/{AGENT_VERSION}",
        },
        method="GET",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
        except Exception:
            body = ""
        return e.code, body
    except Exception as e:
        return None, str(e)


def cloud_post(url, api_key, payload, timeout=10):
    """POST JSON to a cloud endpoint with Bearer auth.
    Returns (status_code_or_None, body_or_err_str)."""
    data = json.dumps(payload).encode()
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "User-Agent": f"PrintAgent/{AGENT_VERSION}",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode()
        except Exception:
            body = ""
        return e.code, body
    except Exception as e:
        return None, str(e)


def poll_and_print_jobs(api_url, api_key, machine_id):
    """Fetch any pending jobs assigned to this machine and print them."""
    import base64
    url = f"{api_url}/api/agent/jobs?machine_id={urllib.parse.quote(machine_id)}"
    code, body = cloud_get(url, api_key, timeout=15)
    if code != 200 or not isinstance(body, dict):
        return  # silent — network hiccup, will retry next cycle

    jobs = body.get("jobs") or []
    for job in jobs:
        job_id = job.get("id")
        printer = job.get("printer_name") or None
        copies = int(job.get("copies") or 1)
        title = str(job.get("file_name") or "print-job")
        pdf_b64 = job.get("pdf_b64") or ""

        if not job_id or not pdf_b64:
            continue

        # Check current job status before printing — the user may have cancelled
        # the job after it was claimed but before we started printing it.
        status_code, status_body = cloud_get(
            f"{api_url}/api/agent/jobs/{job_id}/status",
            api_key,
            timeout=10,
        )
        if status_code == 200 and isinstance(status_body, dict) and status_body.get("cancelled"):
            print(f"[Print Agent] Job #{job_id} was cancelled — skipping")
            continue
        # If the status check itself fails (network hiccup) we proceed and let
        # _report_done handle the cancelled signal after printing completes.

        try:
            pdf_bytes = base64.b64decode(pdf_b64)
        except Exception as e:
            _report_done(api_url, api_key, job_id, success=False, error=f"base64 decode failed: {e}")
            continue

        print(f"[Print Agent] Printing job #{job_id}: '{title}' "
              f"on '{printer or 'default'}' x{copies}")
        ok, msg = print_pdf(pdf_bytes, printer=printer, copies=copies, title=title)
        _report_done(api_url, api_key, job_id, success=ok, error=None if ok else msg)


def _report_done(api_url, api_key, job_id, success, error):
    """Report job completion to the server."""
    payload = {"success": success}
    if error:
        payload["error"] = error
    code, body = cloud_post(
        f"{api_url}/api/agent/jobs/{job_id}/done",
        api_key,
        payload,
        timeout=10,
    )
    status_word = "done" if success else "failed"
    if code == 200:
        try:
            resp = json.loads(body) if isinstance(body, str) else {}
        except Exception:
            resp = {}
        if resp.get("cancelled"):
            print(f"[Print Agent] Job #{job_id} was cancelled by user — ignoring completion")
        else:
            print(f"[Print Agent] Job #{job_id} reported {status_word}")
    else:
        print(f"[Print Agent] Job #{job_id} report {status_word} got HTTP {code}")


def register_once(api_url, api_key, machine_id):
    """Attempt registration with exponential backoff. Returns True on success."""
    register_url = f"{api_url}/api/agent/register"
    for attempt in range(5):
        try:
            printers = get_printers()
            code, msg = cloud_post(register_url, api_key, {
                "machine_id": machine_id,
                "name": get_device_name(),
                "os": get_os_string(),
                "agent_version": AGENT_VERSION,
                "printers": printers,
            })
            if code == 200:
                print(f"[Print Agent] Registered with {api_url} as '{get_device_name()}'")
                return True
            print(f"[Print Agent] Registration attempt {attempt + 1} failed "
                  f"(status={code}): {msg}")
        except Exception as e:
            print(f"[Print Agent] Registration attempt {attempt + 1} crashed: {e}")
        time.sleep(min(2 ** attempt, 30))
    return False


def register_and_heartbeat_loop():
    """Background thread: load config, register, heartbeat every
    HEARTBEAT_INTERVAL_SEC. If unconfigured, idle and re-check every 30s
    so /configure can wake us up without restarting the process."""
    # Initial load from disk into shared config
    cfg = load_config()
    if cfg:
        with _config_lock:
            _current_config["api_key"] = cfg["api_key"]
            _current_config["api_url"] = cfg["api_url"].rstrip("/")
            _current_config["machine_id"] = get_machine_id()
        register_once(
            _current_config["api_url"],
            _current_config["api_key"],
            _current_config["machine_id"],
        )
    else:
        print("[Print Agent] Not yet paired — waiting for /configure call.")

    last_heartbeat = 0.0

    while True:
        try:
            time.sleep(JOB_POLL_INTERVAL_SEC)
            with _config_lock:
                api_url = _current_config.get("api_url")
                api_key = _current_config.get("api_key")
                machine_id = _current_config.get("machine_id")

            if not api_key:
                continue  # still unpaired; keep idling

            # --- Job polling (every JOB_POLL_INTERVAL_SEC) ---
            try:
                poll_and_print_jobs(api_url, api_key, machine_id)
            except Exception as e:
                print(f"[Print Agent] Job poll error: {e}")

            # --- Heartbeat (every HEARTBEAT_INTERVAL_SEC) ---
            now = time.monotonic()
            if now - last_heartbeat < HEARTBEAT_INTERVAL_SEC:
                continue
            last_heartbeat = now

            code, msg = cloud_post(
                f"{api_url}/api/agent/heartbeat",
                api_key,
                {"machine_id": machine_id, "printers": get_printers()},
            )
            if code == 200:
                pass  # normal
            elif code == 404:
                print("[Print Agent] Heartbeat 404 — re-registering")
                register_once(api_url, api_key, machine_id)
            else:
                print(f"[Print Agent] Heartbeat failed (status={code}): {msg}")
        except Exception as e:
            print(f"[Print Agent] Cloud sync loop error: {e}")


def get_printers():
    """Return list of available printers via lpstat."""
    try:
        result = subprocess.run(
            ["lpstat", "-a"],
            capture_output=True, text=True, timeout=5
        )
        printers = []
        for line in result.stdout.strip().split("\n"):
            if line:
                name = line.split(" ")[0]
                if name:
                    printers.append(name)
        return printers
    except Exception:
        return []


def print_pdf(pdf_bytes, printer=None, copies=1, title="print-job"):
    """Send PDF bytes to the printer using the lp command."""
    cmd = ["lp"]
    if printer:
        cmd += ["-d", printer]
    if copies > 1:
        cmd += ["-n", str(copies)]
    cmd += ["-t", title]

    with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
        f.write(pdf_bytes)
        tmp_path = f.name

    try:
        cmd.append(tmp_path)
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode != 0:
            return False, result.stderr.strip() or "Unknown printer error"
        return True, result.stdout.strip()
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


class PrintAgentHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, format, *args):
        print(f"[Print Agent] {self.address_string()} — {format % args}")

    def _send_cors_headers(self):
        # Strict origin allowlist — reflecting an arbitrary Origin would let
        # any website that the user happens to be visiting reconfigure the
        # local agent (CSRF / DNS-rebinding style attack). We only echo back
        # the origin if it's explicitly trusted.
        origin = self.headers.get("Origin", "")
        if is_origin_allowed(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Max-Age", "600")
            # Chrome Private Network Access — needed when an https page calls
            # a private/loopback IP. Harmless on browsers that ignore it.
            self.send_header("Access-Control-Allow-Private-Network", "true")

    def send_json(self, code, data):
        body = json.dumps(data, indent=2).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Content-Length", "0")
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/health":
            with _config_lock:
                configured = bool(_current_config.get("api_key"))
            self.send_json(200, {
                "status": "ok",
                "service": "print-agent",
                "version": AGENT_VERSION,
                "configured": configured,
                "machine_id": get_machine_id(),
                "device_name": get_device_name(),
            })

        elif path == "/printers":
            printers = get_printers()
            self.send_json(200, {"printers": printers, "count": len(printers)})

        else:
            self.send_json(404, {"error": "Not found"})

    def do_POST(self):
        path = urllib.parse.urlparse(self.path).path

        if path == "/configure":
            self._handle_configure()
            return

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

    def _handle_configure(self):
        """Pair this agent with a Presentail account.

        Body: {"api_key": "pk_live_...", "api_url": "https://..."}
        Writes config, kicks off immediate registration, returns the
        device record so the browser can confirm success.
        """
        try:
            length = int(self.headers.get("Content-Length", 0))
            if length == 0 or length > 8192:
                self.send_json(400, {"error": "Invalid request body"})
                return
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self.send_json(400, {"error": "Invalid JSON"})
            return

        # Origin enforcement: only trusted dashboards may pair the agent.
        # Without this, any malicious site the user visits could re-link
        # this agent to the attacker's account and steal print jobs.
        origin = self.headers.get("Origin", "")
        if not is_origin_allowed(origin):
            self.send_json(403, {"error": "Origin not allowed"})
            return

        api_key = str(payload.get("api_key", "")).strip()
        api_url = str(payload.get("api_url", DEFAULT_API_URL)).strip().rstrip("/")

        if not api_key.startswith("pk_live_"):
            self.send_json(400, {"error": "Invalid API key"})
            return
        # api_url controls where the agent sends device metadata and bearer
        # tokens — must be one of the trusted dashboards above.
        if not is_api_url_allowed(api_url):
            self.send_json(400, {"error": "API URL not allowed"})
            return

        # Persist config to disk so it survives restarts.
        try:
            write_config(api_key, api_url)
        except Exception as e:
            self.send_json(500, {"error": f"Could not write config: {e}"})
            return

        # Update in-memory shared config so the heartbeat thread picks it up.
        machine_id = get_machine_id()
        with _config_lock:
            _current_config["api_key"] = api_key
            _current_config["api_url"] = api_url
            _current_config["machine_id"] = machine_id

        # Try to register synchronously so we can give the browser an
        # immediate success/failure response. Don't retry here — the
        # background loop will recover if this fails.
        code, msg = cloud_post(
            f"{api_url}/api/agent/register",
            api_key,
            {
                "machine_id": machine_id,
                "name": get_device_name(),
                "os": get_os_string(),
                "agent_version": AGENT_VERSION,
                "printers": get_printers(),
            },
            timeout=15,
        )

        if code == 200:
            self.send_json(200, {
                "ok": True,
                "device_name": get_device_name(),
                "machine_id": machine_id,
            })
        elif code in (401, 403):
            self.send_json(401, {"error": "Server rejected the API key"})
        else:
            self.send_json(502, {
                "error": "Could not reach server",
                "detail": msg[:500] if msg else "",
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
                printer = part.get_payload(decode=False)
                if isinstance(printer, str):
                    printer = printer.strip()
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

        ok, msg = print_pdf(pdf_bytes, printer=printer or None, copies=copies, title=title)
        if ok:
            self.send_json(200, {"status": "queued", "message": msg})
        else:
            self.send_json(500, {"error": msg})


if __name__ == "__main__":
    import sys

    port = DEFAULT_PORT
    if len(sys.argv) > 1:
        try:
            port = int(sys.argv[1])
        except ValueError:
            print(f"[Print Agent] Invalid port '{sys.argv[1]}', using default {DEFAULT_PORT}")

    print(f"[Print Agent] Starting on http://{HOST}:{port}")
    print(f"[Print Agent] Endpoints:")
    print(f"  GET  http://{HOST}:{port}/health")
    print(f"  GET  http://{HOST}:{port}/printers")
    print(f"  POST http://{HOST}:{port}/print")
    print(f"[Print Agent] Press Ctrl+C to stop\n")

    # Start cloud registration + heartbeat in a background thread
    threading.Thread(
        target=register_and_heartbeat_loop,
        name="cloud-sync",
        daemon=True,
    ).start()

    server = http.server.HTTPServer((HOST, port), PrintAgentHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[Print Agent] Stopped.")
