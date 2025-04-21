#!/bin/bash
set -e +u
set -o pipefail

# Check for required environment variables
export NETWORK=hoodi
export NETWORK_STATE_FILE="deployed-${NETWORK}-vaults-testnet.json"
export NETWORK_STATE_DEFAULTS_FILE="vaults-testnet-defaults.json"

export GAS_PRIORITY_FEE=2
# https://github.com/eth-clients/hoodi?tab=readme-ov-file#metadata
export GENESIS_TIME=1742213400
export DSM_PREDEFINED_ADDRESS=0xfF772cd178D04F0B4b1EFB730c5F2B9683B31611

# # https://github.com/eth-clients/hoodi?tab=readme-ov-file#metadata
export DEPOSIT_CONTRACT=0x00000000219ab540356cBB839Cbe05303d7705Fa

rm -f "${NETWORK_STATE_FILE}"
cp "scripts/defaults/${NETWORK_STATE_DEFAULTS_FILE}" "${NETWORK_STATE_FILE}"

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=scratch/steps.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
