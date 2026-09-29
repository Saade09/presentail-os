#!/usr/bin/env python3
"""
Configure the Print Agent to connect to your Presentail account.

Usage:
  configure.py <API_KEY>
  configure.py <API_KEY> <API_URL>

Writes ~/.print-agent/config.json and restarts the running agent so it
registers immediately with print.presentail.com.
"""

import json
import os
import subprocess
import sys
from pathlib import Path

DEFAULT_API_URL = "https://print.presentail.com"
PLIST_LABEL = "com.local.print-agent"


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: configure.py <API_KEY> [API_URL]", file=sys.stderr)
        return 1

    api_key = sys.argv[1].strip()
    api_url = (sys.argv[2].strip() if len(sys.argv) > 2 else DEFAULT_API_URL).rstrip("/")

    if not api_key.startswith("pk_"):
        print("Error: API key should start with 'pk_'.", file=sys.stderr)
        print("Create one at https://print.presentail.com/dashboard/api-keys", file=sys.stderr)
        return 1

    config_dir = Path.home() / ".print-agent"
    config_dir.mkdir(parents=True, exist_ok=True)
    config_file = config_dir / "config.json"

    config = {"api_key": api_key, "api_url": api_url}
    config_file.write_text(json.dumps(config, indent=2) + "\n")
    os.chmod(config_file, 0o600)

    print(f"✓ Wrote {config_file}")
    print(f"  API URL: {api_url}")

    # Restart the LaunchAgent so it picks up the new config and registers
    plist = Path.home() / "Library" / "LaunchAgents" / f"{PLIST_LABEL}.plist"
    if plist.exists():
        subprocess.run(["launchctl", "unload", str(plist)], check=False,
                       stderr=subprocess.DEVNULL)
        subprocess.run(["launchctl", "load", str(plist)], check=True)
        print("✓ Print Agent restarted")
        print()
        print("Your device should appear at:")
        print("  https://print.presentail.com/dashboard/devices")
        print("(within ~10 seconds)")
    else:
        print("(LaunchAgent plist not found — start the agent manually)")

    return 0


if __name__ == "__main__":
    sys.exit(main())
