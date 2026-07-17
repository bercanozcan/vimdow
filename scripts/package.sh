#!/usr/bin/env bash
# Packages the extension into a Chrome Web Store–ready zip: vimdow-<version>.zip
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION=$(python3 -c "import json; print(json.load(open('extension/manifest.json'))['version'])")
OUT="vimdow-$VERSION.zip"

rm -f "$OUT"
(cd extension && zip -r "../$OUT" . -x "*.DS_Store")
echo
echo "Created $OUT"
unzip -l "$OUT"
