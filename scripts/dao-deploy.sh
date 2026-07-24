#!/usr/bin/env bash
set -e +u
set -o pipefail

export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_GAS_REPORT=true
export SKIP_LINT_SOLIDITY=true

bash scripts/run-migration.sh
