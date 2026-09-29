#!/usr/bin/env bash
# Fail if any unquoted inline YAML description contains characters that
# confuse some YAML parsers: ( ) , or backtick.
#
# A description is considered "unquoted" when the value after "description: "
# does not start with " ' | > or { (i.e. it is not a quoted scalar, a block
# scalar, or a YAML flow mapping). Multi-line block scalars (| and >) are
# safe because the parser treats them verbatim; single- and double-quoted
# scalars escape internally; flow mappings ({ ... }) are left untouched
# because they are not human-readable description text.
#
# Usage: bash lint-descriptions.sh [path-to-openapi.yaml]

set -euo pipefail

SPEC="${1:-openapi.yaml}"

if [[ ! -f "$SPEC" ]]; then
  echo "ERROR: spec file not found: $SPEC" >&2
  exit 1
fi

# Match lines whose description value is unquoted plain text containing a
# risky character. Excludes: quoted scalars (" '), block scalars (| >), and
# flow mappings ({ [) which are structurally different from text descriptions.
MATCHES=$(grep -En "description: [^\"'{|\[>].*[(),\`]" "$SPEC" || true)

if [[ -n "$MATCHES" ]]; then
  echo "ERROR: Unquoted YAML descriptions with special characters found in $SPEC:"
  echo "$MATCHES"
  echo ""
  echo "Wrap the value in double quotes to fix, e.g.:"
  echo '  description: "My description (with parens)"'
  exit 1
fi

echo "OK: no unquoted descriptions with special characters found."
