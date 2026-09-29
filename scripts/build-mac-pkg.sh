#!/bin/bash
# ─────────────────────────────────────────────────────────────
# Build a macOS flat .pkg installer for Print Agent
# Requires: xar, cpio, python3, ImageMagick (`magick`)
#
# Usage:
#   ./scripts/build-mac-pkg.sh [output-path]
#
# Default output: /tmp/PrintAgent.pkg
#
# What gets installed:
#   /Applications/Presentail Print Agent.app   (double-clickable launcher)
#   /usr/local/lib/print-agent/                (agent files)
#   ~/Library/LaunchAgents/com.local.print-agent.plist (auto-start at login)
# ─────────────────────────────────────────────────────────────

set -e

WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
AGENT_DIR="$WORKSPACE_DIR/print-agent"
WEB_DIR="$WORKSPACE_DIR/artifacts/print-agent-web"
SCRIPTS_DIR_SRC="$WORKSPACE_DIR/scripts"
OUTPUT="${1:-/tmp/PrintAgent.pkg}"
INSTALL_PREFIX="/Library/Application Support/Presentail"
APP_NAME="Presentail Print Agent"
CONNECT_URL="https://print.presentail.com/connect"

WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

PAYLOAD_ROOT="$WORK_DIR/payload"
PKG_DIR="$WORK_DIR/pkg"
SCRIPTS_STAGING="$WORK_DIR/scripts"   # staged separately; packed as cpio into PKG_DIR/Scripts
ICON_DIR="$WORK_DIR/icon"

mkdir -p "$PAYLOAD_ROOT$INSTALL_PREFIX"
mkdir -p "$PAYLOAD_ROOT/Applications/$APP_NAME.app/Contents/MacOS"
mkdir -p "$PAYLOAD_ROOT/Applications/$APP_NAME.app/Contents/Resources"
mkdir -p "$PKG_DIR"
mkdir -p "$SCRIPTS_STAGING"
mkdir -p "$ICON_DIR"

# ── Copy agent files into payload ──────────────────────────────
cp "$AGENT_DIR/print-agent.py"              "$PAYLOAD_ROOT$INSTALL_PREFIX/"
cp "$AGENT_DIR/configure.py"                "$PAYLOAD_ROOT$INSTALL_PREFIX/"
cp "$AGENT_DIR/setup.sh"                   "$PAYLOAD_ROOT$INSTALL_PREFIX/"
cp "$AGENT_DIR/uninstall.sh"               "$PAYLOAD_ROOT$INSTALL_PREFIX/"
cp "$AGENT_DIR/com.local.print-agent.plist" "$PAYLOAD_ROOT$INSTALL_PREFIX/"
cp "$AGENT_DIR/README.md"                  "$PAYLOAD_ROOT$INSTALL_PREFIX/"

chmod 755 "$PAYLOAD_ROOT$INSTALL_PREFIX/print-agent.py"
chmod 755 "$PAYLOAD_ROOT$INSTALL_PREFIX/configure.py"
chmod 755 "$PAYLOAD_ROOT$INSTALL_PREFIX/setup.sh"
chmod 755 "$PAYLOAD_ROOT$INSTALL_PREFIX/uninstall.sh"

# ── Build the .app bundle ──────────────────────────────────────
APP_BUNDLE="$PAYLOAD_ROOT/Applications/$APP_NAME.app"

# Render icon at multiple sizes from the brand SVG and pack as .icns
LOGO_SVG="$WEB_DIR/public/logo.svg"
if [ -f "$LOGO_SVG" ] && command -v magick >/dev/null 2>&1; then
  for size in 32 64 128 256 512 1024; do
    magick -background none "$LOGO_SVG" -resize "${size}x${size}" \
      "$ICON_DIR/icon-${size}.png" >/dev/null 2>&1
  done
  python3 "$SCRIPTS_DIR_SRC/make_icns.py" \
    "$APP_BUNDLE/Contents/Resources/AppIcon.icns" \
    32:"$ICON_DIR/icon-32.png" \
    64:"$ICON_DIR/icon-64.png" \
    128:"$ICON_DIR/icon-128.png" \
    256:"$ICON_DIR/icon-256.png" \
    512:"$ICON_DIR/icon-512.png" \
    1024:"$ICON_DIR/icon-1024.png" >/dev/null
  ICON_KEY='<key>CFBundleIconFile</key>
    <string>AppIcon</string>'
else
  echo "Warning: skipping app icon (logo.svg or ImageMagick not found)"
  ICON_KEY=""
fi

# Info.plist
cat > "$APP_BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>com.presentail.print-agent</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleExecutable</key>
    <string>presentail-print-agent</string>
    $ICON_KEY
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleSignature</key>
    <string>????</string>
    <key>LSMinimumSystemVersion</key>
    <string>10.13</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
PLIST

# Launcher script — opens the browser to the connect/dashboard page so
# the user can manage their agent without ever opening Terminal.
cat > "$APP_BUNDLE/Contents/MacOS/presentail-print-agent" << LAUNCHER
#!/bin/bash
# Presentail Print Agent launcher
# The actual print agent runs as a background LaunchAgent. This .app
# is the user-facing entry point — double-clicking it opens the
# Presentail dashboard so they can connect, manage devices, and view
# print history.
URL="$CONNECT_URL"
# If the agent is already configured locally, jump straight to the
# devices page; otherwise land on /connect for first-time pairing.
if curl -sf --max-time 2 http://127.0.0.1:9191/health 2>/dev/null \
     | grep -q '"configured": *true'; then
  URL="https://print.presentail.com/dashboard/devices"
fi
open "\$URL"
LAUNCHER

chmod 755 "$APP_BUNDLE/Contents/MacOS/presentail-print-agent"

# ── postinstall script ─────────────────────────────────────────
cat > "$SCRIPTS_STAGING/postinstall" << POSTINSTALL
#!/bin/bash
# postinstall — runs as root after payload is extracted

LOG="/tmp/presentail-install.log"
exec > >(tee -a "\$LOG") 2>&1
echo "=== Presentail postinstall started \$(date) ==="

INSTALL_DIR="$INSTALL_PREFIX"
PLIST_NAME="com.local.print-agent"
CONNECT_URL="$CONNECT_URL"

# Determine the real logged-in user (installer runs as root)
if [ -n "\$USER" ] && [ "\$USER" != "root" ]; then
  ACTUAL_USER="\$USER"
elif [ -n "\$SUDO_USER" ]; then
  ACTUAL_USER="\$SUDO_USER"
else
  ACTUAL_USER=\$(stat -f%Su /dev/console 2>/dev/null || logname 2>/dev/null || echo "")
fi

echo "Detected user: '\$ACTUAL_USER'"

if [ -z "\$ACTUAL_USER" ] || [ "\$ACTUAL_USER" = "root" ]; then
  echo "Warning: Could not determine target user. Exiting cleanly."
  exit 0
fi

ACTUAL_HOME=\$(eval echo ~"\$ACTUAL_USER")
USER_UID=\$(id -u "\$ACTUAL_USER" 2>/dev/null || dscl . -read "/Users/\$ACTUAL_USER" UniqueID 2>/dev/null | awk '{print \$2}')
echo "Home: \$ACTUAL_HOME  UID: \$USER_UID"

PLIST_SRC="\$INSTALL_DIR/\$PLIST_NAME.plist"
PLIST_DEST="\$ACTUAL_HOME/Library/LaunchAgents/\$PLIST_NAME.plist"

echo "Setting up LaunchAgent..."
mkdir -p "\$ACTUAL_HOME/Library/LaunchAgents"
chown "\$ACTUAL_USER" "\$ACTUAL_HOME/Library/LaunchAgents" 2>/dev/null || true

if [ -f "\$PLIST_SRC" ]; then
  sed "s|INSTALL_PATH|\$INSTALL_DIR|g" "\$PLIST_SRC" > "\$PLIST_DEST"
  chown "\$ACTUAL_USER" "\$PLIST_DEST"
  chmod 644 "\$PLIST_DEST"
  echo "Plist written to \$PLIST_DEST"
else
  echo "ERROR: plist source not found at \$PLIST_SRC"
fi

echo "Loading LaunchAgent..."
launchctl bootout "gui/\$USER_UID/\$PLIST_NAME" 2>/dev/null || \
  sudo -u "\$ACTUAL_USER" launchctl unload "\$PLIST_DEST" 2>/dev/null || true

launchctl bootstrap "gui/\$USER_UID" "\$PLIST_DEST" 2>/dev/null && \
  echo "Agent bootstrapped via launchctl bootstrap" || \
  { sudo -u "\$ACTUAL_USER" launchctl load "\$PLIST_DEST" 2>/dev/null && \
    echo "Agent loaded via launchctl load" || \
    echo "Warning: launchctl load/bootstrap both failed (agent will start on next login)"; }

echo "Setting up Desktop shortcut..."
DESKTOP="\$ACTUAL_HOME/Desktop"
if [ -d "\$DESKTOP" ]; then
  rm -f "\$DESKTOP/Presentail Print Agent"
  ln -s "/Applications/$APP_NAME.app" "\$DESKTOP/Presentail Print Agent"
  chown -h "\$ACTUAL_USER" "\$DESKTOP/Presentail Print Agent" 2>/dev/null || true
  echo "Desktop shortcut created."
fi

echo "Opening browser to connect page..."
sudo -u "\$ACTUAL_USER" open "\$CONNECT_URL" 2>/dev/null || true

echo "=== Presentail postinstall complete ==="
exit 0
POSTINSTALL

chmod 755 "$SCRIPTS_STAGING/postinstall"

# ── preinstall script (stop old instance) ─────────────────────
cat > "$SCRIPTS_STAGING/preinstall" << 'PREINSTALL'
#!/bin/bash
PLIST_DEST="$HOME/Library/LaunchAgents/com.local.print-agent.plist"
[ -f "$PLIST_DEST" ] && launchctl unload "$PLIST_DEST" 2>/dev/null || true
exit 0
PREINSTALL

chmod 755 "$SCRIPTS_STAGING/preinstall"

# ── Scripts archive (raw cpio; xar applies gzip encoding) ──
# macOS PackageKit expects "Scripts" in the xar to be a cpio archive,
# NOT a raw directory. We do NOT pre-gzip — xar's --compression=gzip
# wraps it once and sets encoding=application/x-gzip in the TOC so
# BOMCopier decompresses it correctly. Pre-gzipping causes
# double-compression and "cpio read error: bad file format".
(cd "$SCRIPTS_STAGING" && find . | cpio -o --format newc 2>/dev/null > "$PKG_DIR/Scripts")

# ── Bill of Materials ─────────────────────────────────────
python3 "$(dirname "$0")/make_bom.py" "$PAYLOAD_ROOT" "$PKG_DIR/Bom"

# ── Payload (raw cpio; xar applies gzip encoding once) ────────
NUM_FILES=$(find "$PAYLOAD_ROOT" | wc -l | tr -d ' ')
INSTALL_KB=$(du -sk "$PAYLOAD_ROOT" | awk '{print $1}')

(cd "$PAYLOAD_ROOT" && find . | cpio -o --format newc 2>/dev/null > "$PKG_DIR/Payload")

# ── PackageInfo XML ───────────────────────────────────────────
cat > "$PKG_DIR/PackageInfo" << EOF
<pkg-info format-version="2" identifier="com.local.print-agent" version="1.0.0" install-location="/" auth="root">
    <payload installKBytes="${INSTALL_KB}" numberOfFiles="${NUM_FILES}"/>
    <scripts>
        <preinstall file="./preinstall"/>
        <postinstall file="./postinstall"/>
    </scripts>
</pkg-info>
EOF

# ── Wrap with xar (custom Python writer for Apple compatibility) ──
# We do NOT use the Linux `xar` tool — it writes raw zlib (78 da)
# but tags entries as application/x-gzip, which macOS BOMCopier
# rejects with "cpio read error: bad file format". make_xar.py
# writes proper gzip-framed (1f 8b 08) data with matching TOC tags.
python3 "$(dirname "$0")/make_xar.py" "$OUTPUT" \
  Bom="$PKG_DIR/Bom" \
  PackageInfo="$PKG_DIR/PackageInfo" \
  Payload="$PKG_DIR/Payload" \
  Scripts="$PKG_DIR/Scripts"

# ── Sanity check: parse our own .pkg the way macOS BOMCopier will ──
# Reads the xar header & TOC, validates gzip framing for each file
# entry, decompresses, and verifies the cpio archives.
OUTPUT_PATH="$OUTPUT" python3 - << 'VERIFY' || exit 1
import gzip, os, struct, sys, xml.etree.ElementTree as ET, zlib, subprocess

with open(os.environ["OUTPUT_PATH"], "rb") as f:
    data = f.read()

magic, hdr_size, version, toc_csize, toc_size, ckalg = struct.unpack(">4sHHQQI", data[:28])
assert magic == b"xar!", f"bad xar magic: {magic!r}"
toc_xml = zlib.decompress(data[hdr_size:hdr_size + toc_csize])
heap_start = hdr_size + toc_csize  # heap begins right after compressed TOC; SHA-1 sits at heap offset 0

root = ET.fromstring(toc_xml)
ns = ""
errors = []
for fnode in root.iter("file"):
    name = fnode.findtext("name")
    d = fnode.find("data")
    enc = d.find("encoding").get("style")
    offset = int(d.findtext("offset"))
    length = int(d.findtext("length"))
    size = int(d.findtext("size"))
    blob = data[heap_start + offset : heap_start + offset + length]
    if enc != "application/x-gzip":
        errors.append(f"{name}: unexpected encoding {enc}")
        continue
    if blob[:3] != b"\x1f\x8b\x08":
        errors.append(f"{name}: missing gzip magic at heap+{offset}")
        continue
    decompressed = gzip.decompress(blob)
    if len(decompressed) != size:
        errors.append(f"{name}: decompressed size {len(decompressed)} != TOC size {size}")
        continue
    print(f"  OK {name}: {length}B gzip → {size}B (proper Apple framing)")

if errors:
    for e in errors:
        print(f"  FAIL {e}", file=sys.stderr)
    sys.exit(1)

# Verify Scripts/Payload cpio readability by piping decompressed bytes to `cpio -t`
for fnode in root.iter("file"):
    name = fnode.findtext("name")
    if name not in ("Scripts", "Payload"):
        continue
    d = fnode.find("data")
    offset = int(d.findtext("offset"))
    length = int(d.findtext("length"))
    blob = data[heap_start + offset : heap_start + offset + length]
    raw = gzip.decompress(blob)
    p = subprocess.run(["cpio", "-t"], input=raw, capture_output=True)
    if p.returncode != 0:
        print(f"  FAIL {name} cpio -t: {p.stderr.decode()}", file=sys.stderr)
        sys.exit(1)
    print(f"  OK {name} cpio -t: {len(p.stdout.decode().splitlines())} entries")
VERIFY

echo "Built: $OUTPUT (verified Apple-compat gzip framing + cpio-readable)"
