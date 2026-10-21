#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
mkdir -p .build
swiftc -parse-as-library Sources/GuardNook/BoardTodo.swift Tests/TodoRolloverChecks.swift -o .build/todo-rollover-checks
.build/todo-rollover-checks
