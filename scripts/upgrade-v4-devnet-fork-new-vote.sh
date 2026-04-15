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
export STEPS_FILE="upgrade/steps-upgrade-v4-devnet-fork-new-vote.json"
export VOTE_DESCRIPTION="upgrade-v4-devnet"
export PROPOSAL_METADATA="upgrade-v4-devnet"
export PROPOSAL_ID=${PROPOSAL_ID:=""}
export HOLDER=0x8943545177806ED17B9F23F0a21ee5948eCaa776

bash scripts/dao-upgrade.sh
