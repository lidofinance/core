#!/bin/bash
set -e +u
set -o pipefail

#
export NETWORK=local
export RPC_URL=${RPC_URL:="http://127.0.0.1:8555"}  # if defined use the value set to default otherwise

export GENESIS_TIME=1639659600  # just some time
# export WITHDRAWAL_QUEUE_BASE_URI="<< SET IF REQUIED >>"
# export DSM_PREDEFINED_ADDRESS="<< SET IF REQUIED >>"
#
export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100
#
export NETWORK_STATE_FILE="deployed-${NETWORK}.json"
export NETWORK_STATE_DEFAULTS_FILE="scripts/scratch/deployed-testnet-defaults.json"

bash scripts/scratch/dao-deploy.sh


# # # Need this to get sure the last transactions are mined
# # yarn hardhat --network $NETWORK run ./scripts/scratch/send-hardhat-mine.js --no-compile
yarn hardhat --network $NETWORK run --no-compile scripts/scratch/send-hardhat-mine.ts

# NETWORK_STATE_FILE=deployed-local.json HARDHAT_FORKING_URL="${RPC_URL}" yarn hardhat run --no-compile ./scripts/scratch/checks/scratch-acceptance-test.js --network hardhat
NETWORK_STATE_FILE=deployed-local.json HARDHAT_FORKING_URL="${RPC_URL}" yarn hardhat --network hardhat run --no-compile scripts/scratch/scratch-acceptance-test.ts
