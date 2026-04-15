#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=local
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"} # if defined use the value set to default otherwise

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE="deployed-local.json"
if [ ! -f "$NETWORK_STATE_FILE" ]; then
  cp deployed-mainnet.json "$NETWORK_STATE_FILE"
fi

export UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-mainnet.toml"
export STEPS_FILE="upgrade/steps-upgrade-v4-test-new-vote.json"
export PROPOSAL_METADATA="v4-upgrade-vote"
export PROPOSAL_ID=${PROPOSAL_ID:=""}
export MODE="forking"

bash scripts/dao-upgrade.sh
