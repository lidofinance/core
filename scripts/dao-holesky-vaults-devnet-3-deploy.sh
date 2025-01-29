#!/bin/bash
set -e +u
set -o pipefail

# Check for required environment variables
export NETWORK=holesky
export NETWORK_STATE_FILE="deployed-${NETWORK}-vaults-devnet-3.json"
export NETWORK_STATE_DEFAULTS_FILE="testnet-defaults.json"

# Accounting Oracle args
export GAS_PRIORITY_FEE=2
export GENESIS_TIME=1695902400
export DSM_PREDEFINED_ADDRESS=0x22f05077be05be96d213c6bdbd61c8f506ccd126

# Holesky params: https://github.com/eth-clients/holesky/blob/main/README.md
export DEPOSIT_CONTRACT=0x4242424242424242424242424242424242424242

rm -f "${NETWORK_STATE_FILE}"
cp "scripts/defaults/${NETWORK_STATE_DEFAULTS_FILE}" "${NETWORK_STATE_FILE}"

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=scratch/steps.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
