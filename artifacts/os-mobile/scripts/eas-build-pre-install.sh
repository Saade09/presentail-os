#!/usr/bin/env bash
# EAS build lifecycle hook — runs BEFORE npm/pnpm install on every EAS build.
# EAS invokes this automatically because it is listed as the "eas-build-pre-install"
# script in package.json. expo prebuild then runs separately (managed by EAS).
#
# Purpose: write the real google-services.json so the Android Gradle plugin
# (applied by expo prebuild) can embed Firebase config into the APK/AAB.
#
# EAS secret files (type "file") inject a FILESYSTEM PATH to the downloaded
# file into the named env var — NOT base64-encoded content.
#
# To set up (one-time, from the EAS project root):
#   eas secret:create --scope project \
#     --name GOOGLE_SERVICES_JSON \
#     --type file \
#     --value /path/to/real/google-services.json
#
# Working directory when this script runs is the EAS project root,
# which is artifacts/os-mobile/ (where eas.json lives).

set -euo pipefail

echo "[eas-build-pre-install] Validating Apple sign-in release configuration..."
node --test tests/apple-sign-in-release.test.mjs

DEST="./google-services.json"

if [ -n "${GOOGLE_SERVICES_JSON:-}" ]; then
  echo "[eas-build-pre-install] Copying google-services.json from EAS secret file..."
  # GOOGLE_SERVICES_JSON is a filesystem path to the downloaded secret on the EAS runner.
  cp "$GOOGLE_SERVICES_JSON" "$DEST"
  echo "[eas-build-pre-install] Written to $DEST"
else
  echo "[eas-build-pre-install] WARNING: GOOGLE_SERVICES_JSON secret is not set."
  echo "  Android FCM / expo-notifications will not work correctly."
  echo "  Run: eas secret:create --scope project --name GOOGLE_SERVICES_JSON --type file --value /path/to/google-services.json"
  # Do not exit 1 — allow the build to proceed so other issues surface.
fi
