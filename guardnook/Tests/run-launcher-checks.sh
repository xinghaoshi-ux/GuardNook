#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build
swiftc -parse-as-library Sources/GuardNook/Launcher/LauncherAppInfo.swift Sources/GuardNook/Launcher/LauncherScanner.swift Sources/GuardNook/Launcher/LauncherModel.swift Sources/GuardNook/Launcher/LauncherPanelLayout.swift Tests/LauncherChecks.swift -o .build/launcher-checks
.build/launcher-checks
