#!/bin/bash
# ─────────────────────────────────────────────
# Print Agent — Uninstall Script
# Stops the agent and removes the LaunchAgent.
# ─────────────────────────────────────────────

PLIST_LABEL="com.local.print-agent"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Print Agent — Uninstall"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

if [ -f "$PLIST_DEST" ]; then
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
    rm "$PLIST_DEST"
    echo "✓ Print Agent stopped and removed."
else
    echo "No installed LaunchAgent found at $PLIST_DEST"
fi

# Remove Desktop shortcut and the .app bundle if present.
DESKTOP_LINK="$HOME/Desktop/Presentail Print Agent"
if [ -L "$DESKTOP_LINK" ] || [ -e "$DESKTOP_LINK" ]; then
    rm -f "$DESKTOP_LINK"
    echo "✓ Desktop shortcut removed."
fi
if [ -d "/Applications/Presentail Print Agent.app" ]; then
    rm -rf "/Applications/Presentail Print Agent.app" 2>/dev/null \
        || sudo rm -rf "/Applications/Presentail Print Agent.app"
    echo "✓ Removed /Applications/Presentail Print Agent.app"
fi
echo ""
echo "Note: The script files in /usr/local/lib/print-agent/ were NOT deleted."
echo "      You can safely remove them manually if you no longer need them."
echo ""
