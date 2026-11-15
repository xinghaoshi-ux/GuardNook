#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build
swiftc -parse-as-library Sources/GuardNook/GuardSettings.swift Sources/GuardNook/GuardStatus.swift Sources/GuardNook/GuardStatusDisplay.swift Sources/GuardNook/GuardLocalEnv.swift Sources/GuardNook/GuardExitProbe.swift Sources/GuardNook/LocalVerdict.swift Tests/LocalNetworkChecks.swift -o .build/local-network-checks
.build/local-network-checks "$@"
