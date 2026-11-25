#!/bin/sh
# Builds bin/AgentBridge.app: a background (LSUIElement) app bundle whose executable is the helper,
# a universal (arm64 + x86_64) Mach-O; the whole bundle is ad-hoc signed. Dev and tests use this one.
# The bundle is why macOS dialogs (Touch ID, keychain) say "AgentBridge" and show our icon.
# Releases ship signed/AgentBridge.app instead: the same build, signed with Developer ID + hardened runtime by
# scripts/sign-helper.ts, which calls this script with --out and --identity (docs/release-signing.md).
# Usage: native/build.sh [--if-missing] [--out <dir>] [--identity <codesign identity>]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(dirname "$here")"
out="$pkg/bin"
identity=""
if_missing=""
while [ $# -gt 0 ]; do
  case "$1" in
    --if-missing) if_missing=1 ;;
    --out) out="$2"; shift ;;
    --identity) identity="$2"; shift ;;
    *) echo "usage: build.sh [--if-missing] [--out <dir>] [--identity <codesign identity>]" >&2; exit 2 ;;
  esac
  shift
done
app="$out/AgentBridge.app"
exe="$app/Contents/MacOS/AgentBridge"
fresh() {
  [ -n "$if_missing" ] && [ -x "$exe" ] \
    && [ "$exe" -nt "$here/main.swift" ] && [ "$exe" -nt "$here/Info.plist" ] && [ "$exe" -nt "$here/AppIcon.icns" ] && [ "$here/build.sh" -ot "$exe" ]
}
if fresh; then exit 0; fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "AgentBridge.app: macOS only; skipping build" >&2
  exit 0
fi
command -v swiftc >/dev/null 2>&1 || { echo "AgentBridge.app: swiftc not found (install Xcode Command Line Tools: xcode-select --install)" >&2; exit 1; }

# One build at a time: test files run in parallel and each may call this with --if-missing. Two builds
# racing the final rm + mv would nest one bundle inside the other ("unsealed contents present in the
# bundle root"). mkdir is atomic, so it serves as the lock.
mkdir -p "$out"
lock="$out/.build.lock"
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
if fresh; then exit 0; fi

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
# Identifier = the bundle id in both signatures. Developer ID adds the hardened runtime and a secure timestamp
# (no entitlements: LocalAuthentication and the login keychain need none).
if [ -n "$identity" ]; then
  codesign --force --options runtime --timestamp --identifier live.musi.agentbridge --sign "$identity" "$b"
else
  codesign --force --sign - --identifier live.musi.agentbridge "$b"
fi
codesign --verify --strict "$b"
rm -rf "$app" "$out/agentbridge-helper"
mv "$b" "$app"
echo "built $app ($(lipo -archs "$exe"), $(wc -c < "$exe" | tr -d ' ') bytes)" >&2
