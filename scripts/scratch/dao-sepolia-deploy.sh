#!/bin/bash
set -e +u
set -o pipefail

#
export NETWORK=sepolia
export RPC_URL=https://sepolia.drpc.org

export GENESIS_TIME=1639659600  # just some time
# export WITHDRAWAL_QUEUE_BASE_URI="<< SET IF REQUIED >>"
# export DSM_PREDEFINED_ADDRESS="<< SET IF REQUIED >>"
#
export DEPLOYER=  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=2
export GAS_MAX_FEE=100
#
export NETWORK_STATE_FILE="deployed-${NETWORK}.json"
export NETWORK_STATE_DEFAULTS_FILE="scripts/scratch/deployed-testnet-defaults.json"

bash scripts/scratch/dao-deploy.sh
