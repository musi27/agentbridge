#!/bin/sh
# Builds bin/AgentBridge.app: a background (LSUIElement) app bundle whose executable is the helper,
# a universal (arm64 + x86_64) Mach-O; the whole bundle is ad-hoc signed.
# The bundle is why macOS dialogs (Touch ID, keychain) say "AgentBridge" and show our icon.
# Release builds are re-signed with Developer ID + hardened runtime (docs/release-signing.md).
# Usage: native/build.sh [--if-missing]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(dirname "$here")"
app="$pkg/bin/AgentBridge.app"
exe="$app/Contents/MacOS/AgentBridge"
if [ "${1:-}" = "--if-missing" ] && [ -x "$exe" ] \
  && [ "$exe" -nt "$here/main.swift" ] && [ "$exe" -nt "$here/Info.plist" ] && [ "$exe" -nt "$here/AppIcon.icns" ] && [ "$exe" -nt "$0" ]; then
  exit 0
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "AgentBridge.app: macOS only; skipping build" >&2
  exit 0
fi
command -v swiftc >/dev/null 2>&1 || { echo "AgentBridge.app: swiftc not found (install Xcode Command Line Tools: xcode-select --install)" >&2; exit 1; }

min_macos="13.0"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -whole-module-optimization \
    -target "$arch-apple-macosx$min_macos" \
    -module-name AgentBridge \
    -o "$tmp/helper-$arch" "$here/main.swift"
done
b="$tmp/AgentBridge.app"
mkdir -p "$b/Contents/MacOS" "$b/Contents/Resources"
lipo -create -output "$b/Contents/MacOS/AgentBridge" "$tmp/helper-arm64" "$tmp/helper-x86_64"
# Info.plist is a fixed file (no version stamped in at build time): with an ad-hoc signature the
# keychain trusts the bundle's cdhash, so it must not change between releases unless the code does.
cp "$here/Info.plist" "$b/Contents/Info.plist"
cp "$here/AppIcon.icns" "$b/Contents/Resources/AppIcon.icns"
plutil -lint -s "$b/Contents/Info.plist"
# Identifier = the bundle id, so a later Developer ID signature refers to the same name.
codesign --force --sign - --identifier live.musi.agentbridge "$b"
codesign --verify --strict "$b"
mkdir -p "$pkg/bin"
rm -rf "$app" "$pkg/bin/agentbridge-helper"
mv "$b" "$app"
echo "built $app ($(lipo -archs "$exe"), $(wc -c < "$exe" | tr -d ' ') bytes)" >&2
