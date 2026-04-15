#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=local
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"} # if defined use the value set to default otherwise

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE="deployed-devnet1.json"
export UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-devnet1.toml"
export STEPS_FILE="upgrade/steps-upgrade-vote.json"

bash scripts/dao-upgrade.sh
