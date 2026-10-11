#!/bin/bash
set -euo pipefail

repo="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd -P)"
source_file="$repo/scripts/atlas-node-ui.swift"
app="$repo/.build/Atlas Node.app"
bundle="$app/Contents"
binary="$bundle/MacOS/AtlasNode"

if [[ "$(uname -s)" != "Darwin" ]]; then
  if [[ "${1:-}" == "--check" ]]; then
    echo "Skipping Swift UI typecheck on non-macOS host."
    exit 0
  fi
  echo "Atlas Node UI requires macOS." >&2
  exit 1
fi
if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo "Swift compiler not available. Install Xcode Command Line Tools (xcode-select --install)." >&2
  exit 1
fi
if [[ "${1:-}" == "--check" ]]; then
  xcrun swiftc -typecheck -parse-as-library -framework SwiftUI -framework AppKit -framework Combine "$source_file"
  echo "Native Atlas Node UI typecheck passed."
  exit 0
fi
mkdir -p "$bundle/MacOS"
if [[ ! -f "$binary" || "$source_file" -nt "$binary" || "$0" -nt "$binary" ]]; then
  echo "Building native Atlas Node menu-bar app…"
  xcrun swiftc -parse-as-library -framework SwiftUI -framework AppKit -framework Combine \
    "$source_file" -o "$binary"
fi

# Only a trusted local repository path is embedded; credentials never enter the bundle.
escape_xml() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' -e "s/'/\&apos;/g"
}
escaped_repo="$(escape_xml "$repo")"
cat > "$bundle/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleExecutable</key><string>AtlasNode</string>
    <key>CFBundleIdentifier</key><string>dev.affan.atlas-node-ui</string>
    <key>CFBundleName</key><string>Atlas Node</string>
    <key>CFBundleDisplayName</key><string>Atlas Node</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>CFBundleVersion</key><string>1</string>
    <key>CFBundleShortVersionString</key><string>1.0</string>
    <key>LSMinimumSystemVersion</key><string>13.0</string>
    <key>LSUIElement</key><true/>
    <key>NSHighResolutionCapable</key><true/>
    <key>AtlasRepositoryPath</key><string>${escaped_repo}</string>
</dict>
</plist>
EOF
plutil -lint "$bundle/Info.plist" >/dev/null
open -a "$app"
echo "Atlas Node is available from the macOS menu bar."
