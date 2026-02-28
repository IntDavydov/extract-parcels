#!/bin/bash
# Build a Windows .exe from Linux.
# Avoids the Windows symlink privilege error by installing with --no-bin-links.
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BUILD_DIR=$(mktemp -d)
echo "→ Staging build in $BUILD_DIR ..."

# Copy project files, skip existing exe and node_modules
rsync -a \
  --exclude='node_modules/' \
  --exclude='kadastr.exe' \
  --exclude='build-win.sh' \
  "$SCRIPT_DIR/" "$BUILD_DIR/"

# Install without creating ANY symlinks (fixes Windows extraction error)
cd "$BUILD_DIR"
echo "→ Running npm install --no-bin-links ..."
npm install --no-bin-links --prefer-offline 2>&1 | tail -5

# Build using caxa from the original project (it stays in main node_modules)
echo "→ Running caxa ..."
node "$SCRIPT_DIR/node_modules/caxa/build/index.mjs" \
  --input "$BUILD_DIR" \
  --output "$SCRIPT_DIR/kadastr.exe" \
  --stub "$SCRIPT_DIR/node_modules/caxa/stubs/stub--win32--x64" \
  --exclude node_modules/.cache \
  -- "{{caxa}}/win-node/node.exe" "{{caxa}}/script.js" "{{arg 1}}"

rm -rf "$BUILD_DIR"
echo "✓ Done! kadastr.exe is ready ($(du -sh "$SCRIPT_DIR/kadastr.exe" | cut -f1))."
