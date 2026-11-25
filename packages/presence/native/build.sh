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
fresh() {
  [ "${1:-}" = "--if-missing" ] && [ -x "$exe" ] \
    && [ "$exe" -nt "$here/main.swift" ] && [ "$exe" -nt "$here/Info.plist" ] && [ "$exe" -nt "$here/AppIcon.icns" ] && [ "$here/build.sh" -ot "$exe" ]
}
if fresh "$@"; then exit 0; fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "AgentBridge.app: macOS only; skipping build" >&2
  exit 0
fi
command -v swiftc >/dev/null 2>&1 || { echo "AgentBridge.app: swiftc not found (install Xcode Command Line Tools: xcode-select --install)" >&2; exit 1; }

# One build at a time: test files run in parallel and each may call this with --if-missing. Two builds
# racing the final rm + mv would nest one bundle inside the other ("unsealed contents present in the
# bundle root"). mkdir is atomic, so it serves as the lock.
mkdir -p "$pkg/bin"
lock="$pkg/bin/.build.lock"
tmp=""
waited=0
until mkdir "$lock" 2>/dev/null; do
  if [ "$waited" -ge 600 ]; then
    echo "AgentBridge.app: another build has held $lock for 10 minutes; if none is running, remove it and retry" >&2
    exit 1
  fi
  sleep 1
  waited=$((waited + 1))
done
trap 'rm -rf "$tmp"; rmdir "$lock" 2>/dev/null || true' EXIT
# A build that held the lock before us may have just produced a fresh bundle.
if fresh "$@"; then exit 0; fi

min_macos="13.0"
tmp="$(mktemp -d)"
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
rm -rf "$app" "$pkg/bin/agentbridge-helper"
mv "$b" "$app"
echo "built $app ($(lipo -archs "$exe"), $(wc -c < "$exe" | tr -d ' ') bytes)" >&2
