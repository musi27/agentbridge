#!/bin/sh
# Builds bin/agentbridge-helper as a universal (arm64 + x86_64) Mach-O, ad-hoc signed.
# Release builds are re-signed with Developer ID + hardened runtime (docs/release-signing.md).
# Usage: native/build.sh [--if-missing]
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
pkg="$(dirname "$here")"
out="$pkg/bin/agentbridge-helper"
if [ "${1:-}" = "--if-missing" ] && [ -x "$out" ] && [ "$out" -nt "$here/main.swift" ]; then
  exit 0
fi
if [ "$(uname -s)" != "Darwin" ]; then
  echo "agentbridge-helper: macOS only; skipping build" >&2
  exit 0
fi
command -v swiftc >/dev/null 2>&1 || { echo "agentbridge-helper: swiftc not found (install Xcode Command Line Tools: xcode-select --install)" >&2; exit 1; }

min_macos="13.0"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -whole-module-optimization \
    -target "$arch-apple-macosx$min_macos" \
    -module-name AgentbridgeHelper \
    -o "$tmp/helper-$arch" "$here/main.swift"
done
mkdir -p "$pkg/bin"
lipo -create -output "$tmp/agentbridge-helper" "$tmp/helper-arm64" "$tmp/helper-x86_64"
# Stable identifier so a later Developer ID signature and keychain ACLs refer to the same name.
codesign --force --sign - --identifier live.musi.agentbridge.helper "$tmp/agentbridge-helper"
mv -f "$tmp/agentbridge-helper" "$out"
echo "built $out ($(lipo -archs "$out"), $(wc -c < "$out" | tr -d ' ') bytes)" >&2
