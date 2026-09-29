#!/usr/bin/env bash
# Root-level reference — the actual EAS lifecycle hook lives at:
#   artifacts/os-mobile/scripts/eas-build-pre-install.sh
#
# It is registered in artifacts/os-mobile/package.json as:
#   "eas-build-pre-install": "bash scripts/eas-build-pre-install.sh"
#
# EAS invokes that hook automatically before npm/pnpm install on every build.
# expo prebuild then runs separately (managed by EAS). This is different from
# eas.json's prebuildCommand which would REPLACE expo prebuild entirely.
#
# See artifacts/os-mobile/GOOGLE_PLAY.md for setup instructions.
echo "See artifacts/os-mobile/scripts/eas-build-pre-install.sh for the actual EAS hook."
