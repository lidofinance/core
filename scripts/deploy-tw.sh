#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=holesky
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}  # if defined use the value set to default otherwise
export SLOTS_PER_EPOCH=32
export GENESIS_TIME=1639659600  # just some time
# export WITHDRAWAL_QUEUE_BASE_URI="<< SET IF REQUIED >>"
# export DSM_PREDEFINED_ADDRESS="<< SET IF REQUIED >>"

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE="deployed-holesky.json"
# export NETWORK_STATE_DEFAULTS_FILE="scripts/scratch/deployed-testnet-defaults.json"


# Need this to get sure the last transactions are mined
yarn hardhat --network $NETWORK run scripts/triggerable-withdrawals/tw-deploy.ts

