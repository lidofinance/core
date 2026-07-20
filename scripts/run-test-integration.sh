#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

load_env_var MODE "forking"
load_env_var NETWORK || {
  echo "Error: NETWORK must be set for integration tests"
  exit 1
}

if [[ -n ${RUN_NETWORK:-} && $RUN_NETWORK != "local" ]]; then
  echo "Error: integration tests require an external node and only support RUN_NETWORK=local"
  exit 1
fi

export RUN_NETWORK="local"
export RPC_URL="${RPC_URL:-http://127.0.0.1:8545}"

export AUTO_CONFIRM=true
export ALLOW_SKIP_STEPS=true
export SKIP_INTERFACES_CHECK=true
export SKIP_CONTRACT_SIZE=true
export SKIP_GAS_REPORT=true
export SKIP_LINT_SOLIDITY=true

prepare_migration_env "test"
prepare_trace_args

yarn hardhat --network "$RUN_NETWORK" test test/integration/**/*.ts "${TRACE_ARGS[@]}"
