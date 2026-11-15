#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
fixture=$(mktemp -d /tmp/guardnook-log-checks.XXXXXX)
trap 'rm -rf "$fixture"' EXIT
swiftc -parse-as-library Sources/GuardNook/GuardLog.swift Sources/GuardNook/GuardLogModel.swift Tests/LogChecks.swift -o "$fixture/log-checks"
"$fixture/log-checks"
