#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

load_env_var MODE "forking"
export AUTO_CONFIRM=true
export ALLOW_SKIP_STEPS=true
export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_GAS_REPORT=true
export SKIP_LINT_SOLIDITY=true

prepare_migration_env
prepare_trace_args

yarn hardhat --network "$RUN_NETWORK" test test/integration/**/*.ts "${TRACE_ARGS[@]}"
