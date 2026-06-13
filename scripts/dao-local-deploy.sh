#!/bin/bash
set -e +u
set -o pipefail

# Scratch-deploy the protocol to a local node (anvil/hardhat) on RPC_URL, then
# run the acceptance/integration suite against the freshly deployed instance.
#
# Output mode: by default this SELF-LOGS — the full combined deploy + test
# output is written to $LOG_FILE (default logs/scratch-deploy.log) while only
# milestones, mocha counts (N passing/pending/failing), and failures reach the
# terminal. This keeps automation / LLM agents (and humans who just want signal)
# out of the gas reports, per-tx traces, and ~700 mocha test ticks. The log also
# emits a periodic heartbeat so a long, quiet phase (e.g. a slow integration
# test) isn't mistaken for a freeze.
#
# For raw, unfiltered output straight to the terminal:
#   FULL_OUTPUT=1 bash scripts/dao-local-deploy.sh
#   bash scripts/dao-local-deploy.sh --full      # equivalent
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
  LOG_FILE="${LOG_FILE:-logs/scratch-deploy.log}"
  exec bash "$HERE/run-logged.sh" "$LOG_FILE" bash "${BASH_SOURCE[0]}" "$@"
fi

export NETWORK=local
export RPC_URL=${RPC_URL:="http://127.0.0.1:8555"}  # if defined use the value set to default otherwise

export GENESIS_TIME=1639659600  # just some time
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

# Run the integration suite against an IN-PROCESS hardhat node that FORKS the
# anvil we just deployed to (MODE=forking: the default `hardhat` network forks
# $RPC_URL at latest; the deployment is read from $NETWORK_STATE_FILE). We do
# NOT drive anvil directly (`--network local`): the suite isolates tests with
# evm_snapshot/evm_revert plus month-scale time jumps, and that isolation is only
# reliable on the in-process node. Driving the external anvil over a long run
# lets snapshot state degrade (cf. the ~6k-block caveat in
# test/integration/core/dsm-pause-deposits.integration.ts), surfacing as
# cascading failures and an eventual mid-suite deadlock.
#
# dao-deploy.sh exports SKIP_GAS_REPORT only inside its own (child) shell, so
# set it here too — otherwise the test phase prints the full gas table.
export SKIP_GAS_REPORT=${SKIP_GAS_REPORT-true}  # re-enable with SKIP_GAS_REPORT=""
export INTEGRATION_WITH_CSM="off"
# PROVISION_ON_FORK: the anvil deploy is deployed-but-not-operational, so the
# in-process fork provisions itself (oracle committee, hash-consensus initial
# epoch, unpause, seed TVL) — the same setup a MODE=scratch run does in-process.
export PROVISION_ON_FORK=1
yarn test:integration   # MODE=forking: in-process fork of $RPC_URL, deployment from $NETWORK_STATE_FILE
