#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Build the macOS PrintAgent.zip distribution.
#
# Output structure (after the user unzips):
#   PrintAgent/
#     PrintAgent/                # agent source files
#       print-agent.py
#       configure.py
#       setup.sh
#       uninstall.sh
#       com.local.print-agent.plist
#       README.md
#     Install.command            # double-clickable installer
#     Uninstall.command          # double-clickable uninstaller
#
# Why .zip + .command instead of .pkg?
#   macOS Sequoia rejects unsigned .pkg files outright with
#   "couldn't open" errors that no Linux-built xar can satisfy.
#   A .zip with .command scripts uses standard Gatekeeper bypass
#   (right-click → Open) and runs identical postinstall logic.
# ─────────────────────────────────────────────────────────────

set -e

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$WORKSPACE_DIR/print-agent"
OUTPUT="${1:-/tmp/PrintAgent.zip}"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

STAGE="$WORK_DIR/PrintAgent"
AGENT_OUT="$STAGE/PrintAgent"
mkdir -p "$AGENT_OUT"

# ── Copy agent source files ──────────────────────────────────
cp "$AGENT_DIR/print-agent.py"              "$AGENT_OUT/"
cp "$AGENT_DIR/configure.py"                "$AGENT_OUT/"
cp "$AGENT_DIR/setup.sh"                    "$AGENT_OUT/"
cp "$AGENT_DIR/uninstall.sh"                "$AGENT_OUT/"
cp "$AGENT_DIR/com.local.print-agent.plist" "$AGENT_OUT/"
cp "$AGENT_DIR/README.md"                   "$AGENT_OUT/"

chmod 755 "$AGENT_OUT/print-agent.py"
chmod 755 "$AGENT_OUT/configure.py"
chmod 755 "$AGENT_OUT/setup.sh"
chmod 755 "$AGENT_OUT/uninstall.sh"
chmod 644 "$AGENT_OUT/com.local.print-agent.plist"
chmod 644 "$AGENT_OUT/README.md"

# ── Install.command ──────────────────────────────────────────
cat > "$STAGE/Install.command" << 'INSTALL_EOF'
#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Presentail Print Agent — Installer
# Double-click in Finder to install. (Right-click → Open the
# first time so macOS Gatekeeper allows the unsigned script.)
# ─────────────────────────────────────────────────────────────

LOG="/tmp/presentail-install.log"
exec > >(tee -a "$LOG") 2>&1
echo ""
echo "================================================================"
echo "  Presentail Print Agent — Installer"
echo "  $(date)"
echo "================================================================"
echo ""

INSTALL_DIR="$HOME/Library/Application Support/Presentail"
PLIST_NAME="com.local.print-agent"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"
CONNECT_URL="https://print.presentail.com/connect"

# Resolve where this .command lives — agent files are in ./PrintAgent/ next to it.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/PrintAgent"

if [ ! -d "$SOURCE_DIR" ]; then
  echo "ERROR: agent files not found at: $SOURCE_DIR"
  echo ""
  echo "Did you double-click Install.command from inside the unzipped folder?"
  echo "If you ran it directly from the .zip, please first unzip PrintAgent.zip"
  echo "to a real folder (e.g. Desktop) and try again."
  echo ""
  read -p "Press Enter to close this window..."
  exit 1
fi

echo "Source files:    $SOURCE_DIR"
echo "Install target:  $INSTALL_DIR"
echo ""

# Stop any previous instance
if [ -f "$PLIST_DEST" ]; then
  echo "→ Stopping existing Print Agent..."
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || \
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Install files
echo "→ Copying agent files..."
mkdir -p "$INSTALL_DIR"
cp "$SOURCE_DIR"/print-agent.py              "$INSTALL_DIR/"
cp "$SOURCE_DIR"/configure.py                "$INSTALL_DIR/"
cp "$SOURCE_DIR"/setup.sh                    "$INSTALL_DIR/"
cp "$SOURCE_DIR"/uninstall.sh                "$INSTALL_DIR/"
cp "$SOURCE_DIR"/com.local.print-agent.plist "$INSTALL_DIR/"
cp "$SOURCE_DIR"/README.md                   "$INSTALL_DIR/"
chmod 755 "$INSTALL_DIR/print-agent.py" "$INSTALL_DIR/configure.py" \
          "$INSTALL_DIR/setup.sh" "$INSTALL_DIR/uninstall.sh"
echo "  done."

# LaunchAgent
echo "→ Registering LaunchAgent (auto-start at login)..."
mkdir -p "$HOME/Library/LaunchAgents"
sed "s|INSTALL_PATH|$INSTALL_DIR|g" \
    "$INSTALL_DIR/com.local.print-agent.plist" > "$PLIST_DEST"
chmod 644 "$PLIST_DEST"
echo "  written: $PLIST_DEST"

# Load
echo "→ Starting Print Agent in background..."
if launchctl bootstrap "gui/$(id -u)" "$PLIST_DEST" 2>/dev/null; then
  echo "  loaded via launchctl bootstrap."
elif launchctl load "$PLIST_DEST" 2>/dev/null; then
  echo "  loaded via launchctl load."
else
  echo "  (will start on next login if launchctl is restricted now)"
fi

# Wait for the local agent to come up, then open browser
echo "→ Opening browser to $CONNECT_URL ..."
for i in 1 2 3 4 5 6 7 8 9 10; do
  if curl -sf --max-time 1 http://127.0.0.1:9191/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
open "$CONNECT_URL" 2>/dev/null || true

echo ""
echo "================================================================"
echo "  ✓ Install complete."
echo "  • The Print Agent is running in the background."
echo "  • It will start automatically every time you log in."
echo "  • To uninstall: double-click Uninstall.command"
echo "  • Log file: $LOG"
echo "================================================================"
echo ""
sleep 3
INSTALL_EOF

chmod 755 "$STAGE/Install.command"

# ── Uninstall.command ────────────────────────────────────────
cat > "$STAGE/Uninstall.command" << 'UNINSTALL_EOF'
#!/bin/bash
# Presentail Print Agent — Uninstaller

INSTALL_DIR="$HOME/Library/Application Support/Presentail"
PLIST_NAME="com.local.print-agent"
PLIST_DEST="$HOME/Library/LaunchAgents/$PLIST_NAME.plist"

echo ""
echo "Uninstalling Presentail Print Agent..."

if [ -f "$PLIST_DEST" ]; then
  launchctl bootout "gui/$(id -u)/$PLIST_NAME" 2>/dev/null || \
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
  rm -f "$PLIST_DEST"
  echo "  • LaunchAgent removed"
fi

if [ -d "$INSTALL_DIR" ]; then
  rm -rf "$INSTALL_DIR"
  echo "  • Files removed: $INSTALL_DIR"
fi

echo ""
echo "✓ Uninstall complete."
echo ""
sleep 2
UNINSTALL_EOF

chmod 755 "$STAGE/Uninstall.command"

# ── Zip it up (preserve Unix permissions, esp. exec bit on .command) ──
rm -f "$OUTPUT"
SRC_ROOT="$WORK_DIR" OUT="$OUTPUT" python3 - << 'ZIP_EOF'
import os, stat, zipfile
src = os.environ["SRC_ROOT"]
out = os.environ["OUT"]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
    for root, dirs, files in os.walk(os.path.join(src, "PrintAgent")):
        dirs.sort(); files.sort()
        for name in files:
            path = os.path.join(root, name)
            arcname = os.path.relpath(path, src)
            st = os.stat(path)
            zi = zipfile.ZipInfo.from_file(path, arcname)
            # Preserve the full Unix file-mode in external_attr (high 16 bits).
            # macOS Archive Utility honours this and re-applies the exec bit.
            zi.external_attr = (st.st_mode & 0xFFFF) << 16
            zi.compress_type = zipfile.ZIP_DEFLATED
            with open(path, "rb") as f:
                zf.writestr(zi, f.read())

# ── Verify .command files have exec bit inside the zip ──
with zipfile.ZipFile(out) as zf:
    for must_exec in ("PrintAgent/Install.command", "PrintAgent/Uninstall.command"):
        info = zf.getinfo(must_exec)
        mode = (info.external_attr >> 16) & 0xFFFF
        if not (mode & stat.S_IXUSR):
            raise SystemExit(f"FAIL: {must_exec} not executable in zip (mode={oct(mode)})")
        print(f"  OK {must_exec}: mode={oct(mode)}")
    print(f"  OK total entries: {len(zf.namelist())}")
ZIP_EOF

SIZE=$(du -k "$OUTPUT" | awk '{print $1}')
echo "Built: $OUTPUT (${SIZE} KB)"
