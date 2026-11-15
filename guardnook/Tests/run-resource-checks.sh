#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fixture=$(mktemp -d /tmp/guardnook-resource-check.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
app="$fixture/ResourceCheck.app"
mkdir -p "$app/Contents/MacOS" "$app/Contents/Resources"
cp -R Sources/GuardNook/Resources "$app/Contents/Resources/GuardNook_GuardNook.bundle"
swiftc -parse-as-library Sources/GuardNook/GuardResources.swift Tests/ResourceChecks.swift -o "$app/Contents/MacOS/ResourceCheck"
cat > "$app/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>ResourceCheck</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>
PLIST
cd /
"$app/Contents/MacOS/ResourceCheck"
mv "$app/Contents/Resources/GuardNook_GuardNook.bundle" "$fixture/removed.bundle"
"$app/Contents/MacOS/ResourceCheck" --expect-missing
