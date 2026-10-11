#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRATCH_DIR="$(mktemp -d /tmp/stalwart-mail-labels.XXXXXX)"
APP_DIR="$SCRATCH_DIR/Stalwart Mail Labels.app"
OUTPUT_DIR="$PROJECT_DIR/dist"
OUTPUT_ZIP="$OUTPUT_DIR/Stalwart Mail Labels.zip"
trap 'rm -rf "$SCRATCH_DIR"' EXIT

cd "$PROJECT_DIR"
swift build -c release --product MailLabels --scratch-path "$SCRATCH_DIR/build"

mkdir -p "$APP_DIR/Contents/MacOS" "$APP_DIR/Contents/Resources"
install -m 0755 "$SCRATCH_DIR/build/release/MailLabels" "$APP_DIR/Contents/MacOS/MailLabels"
install -m 0644 "$PROJECT_DIR/Resources/Info.plist" "$APP_DIR/Contents/Info.plist"
codesign --force --sign - "$APP_DIR"
codesign --verify --strict "$APP_DIR"
mkdir -p "$OUTPUT_DIR"
rm -f "$OUTPUT_ZIP"
ditto -c -k --keepParent "$APP_DIR" "$OUTPUT_ZIP"

printf '%s\n' "$OUTPUT_ZIP"
