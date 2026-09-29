#!/bin/bash
# ─────────────────────────────────────────────
# Print Agent — macOS Setup Script
# Installs the agent and registers it as a
# background service that starts at login.
# ─────────────────────────────────────────────

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_LABEL="com.local.print-agent"
PLIST_SRC="$SCRIPT_DIR/$PLIST_LABEL.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Print Agent — Setup"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Install location : $SCRIPT_DIR"
echo "LaunchAgent plist: $PLIST_DEST"
echo ""

# Inject the real install path into the plist
sed "s|INSTALL_PATH|$SCRIPT_DIR|g" "$PLIST_SRC" > "$PLIST_DEST"

# Unload any previously running instance (ignore errors)
launchctl unload "$PLIST_DEST" 2>/dev/null || true

# Load and start the agent
launchctl load "$PLIST_DEST"

echo "✓ Print Agent installed and started!"
echo ""
echo "It will now start automatically every time you log in."
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Quick test commands"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  Check health:    curl http://127.0.0.1:9191/health"
echo "  List printers:   curl http://127.0.0.1:9191/printers"
echo "  Print a PDF:     curl -X POST http://127.0.0.1:9191/print \\"
echo "                        -H 'Content-Type: application/pdf' \\"
echo "                        --data-binary @/path/to/file.pdf"
echo ""
echo "  Logs:            tail -f /tmp/print-agent.log"
echo ""
echo "  To stop & remove, run: ./uninstall.sh"
echo ""
