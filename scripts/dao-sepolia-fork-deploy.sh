#!/bin/bash
set -e +u
set -o pipefail

# Scratch deploy against a local anvil fork of Sepolia. Mirrors
# `dao-local-deploy.sh` but switches in Sepolia-specific chain spec so
# `0010-deploy-deposit-contract` picks the `SepoliaDepositAdapter` branch
# (triggered by chainId == 11155111, which anvil preserves from the upstream
# fork node by default).
#
# Prereq: start anvil first, e.g.
#   anvil --fork-url "$SEPOLIA_RPC_URL" -p 8555 --base-fee 0 --gas-price 0
#
# Output mode: by default this SELF-LOGS — the full combined deploy + test
# output is written to $LOG_FILE (default logs/scratch-deploy-sepolia-fork.log)
# while only milestones, mocha counts, and failures (plus a periodic heartbeat)
# reach the terminal. For raw, unfiltered output straight to the terminal:
#   FULL_OUTPUT=1 bash scripts/dao-sepolia-fork-deploy.sh
#   bash scripts/dao-sepolia-fork-deploy.sh --full      # equivalent
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# --full / --raw (or FULL_OUTPUT=1) bypasses the log filter.
if [[ "${1:-}" == "--full" || "${1:-}" == "--raw" ]]; then
  FULL_OUTPUT=1
  shift
fi

# Self-wrap through run-logged.sh unless full output is requested or we are
# already inside the wrapper (the guard prevents an exec loop).
if [[ -z "${FULL_OUTPUT:-}" && -z "${_DEPLOY_LOGGED:-}" ]]; then
  export _DEPLOY_LOGGED=1
  LOG_FILE="${LOG_FILE:-logs/scratch-deploy-sepolia-fork.log}"
  exec bash "$HERE/run-logged.sh" "$LOG_FILE" bash "${BASH_SOURCE[0]}" "$@"
fi

export NETWORK=local
export RPC_URL=${RPC_URL:="http://127.0.0.1:8555"}

export GENESIS_TIME=1655733600           # Sepolia beacon genesis
export GENESIS_FORK_VERSION=0x90000069   # Sepolia
# export WITHDRAWAL_QUEUE_BASE_URI="<< SET IF REQUIRED >>"
# export DSM_PREDEFINED_ADDRESS="<< SET IF REQUIRED >>"

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE="deployed-${NETWORK}.json"
export SCRATCH_DEPLOY_CONFIG="scripts/scratch/deploy-params-testnet.toml"
export DG_ALLOW_DEV_COMMITTEES=1

bash scripts/dao-deploy.sh

# Need this to get sure the last transactions are mined
yarn hardhat --network $NETWORK run --no-compile scripts/utils/mine.ts

# Discover the deployment just created and provision/test it on the same external
# node. The runner supports RUN_NETWORK=local and snapshots that node directly.
# Long suites depend on external-node snapshot/revert support. The DSM pause test
# limits mining because Hardhat snapshot restoration can fail after ~6k blocks;
# see test/integration/core/dsm-pause-deposits.integration.ts.
export SKIP_GAS_REPORT=${SKIP_GAS_REPORT-true}
export INTEGRATION_WITH_CSM="off"
export PROVISION_ON_FORK=1
export MODE=forking
export RUN_NETWORK=local
yarn test:integration
