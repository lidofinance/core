#!/usr/bin/env bash
set -euo pipefail

# Hardhat 2 uses ts-node/CommonJS. Keep Node's native TS and require(ESM)
# loaders disabled, including in Mocha workers and Hardhat child processes.
node -e 'const [major, minor] = process.versions.node.split(".").map(Number); if (!((major === 22 && minor >= 15) || major === 24)) { console.error("Use Node 22.15+ (22.x, see .nvmrc) or Node 24.x for Hardhat."); process.exit(1); }'
export NODE_OPTIONS="${NODE_OPTIONS:-} --no-experimental-strip-types --no-experimental-require-module"
exec node node_modules/hardhat/internal/cli/bootstrap.js "$@"
