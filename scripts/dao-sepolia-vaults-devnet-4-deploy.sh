#!/bin/bash
set -e +u
set -o pipefail

# Check for required environment variables
export NETWORK=sepolia
export NETWORK_STATE_FILE="deployed-${NETWORK}-vaults-devnet-4.json"
export NETWORK_STATE_DEFAULTS_FILE="testnet-defaults.json"

# Accounting Oracle args
export GAS_PRIORITY_FEE=2
# https://github.com/eth-clients/sepolia?tab=readme-ov-file#meta-data-bepolia
export GENESIS_TIME=1655733600
export DSM_PREDEFINED_ADDRESS=0x22f05077be05be96d213c6bdbd61c8f506ccd126

# Sepolia params: https://docs.lido.fi/deployed-contracts/sepolia/#sepolia-deposit-contract-ad-hoc-adapter
export DEPOSIT_CONTRACT=0x80b5DC88C98E528bF9cb4B7F0f076aC41da24651

rm -f "${NETWORK_STATE_FILE}"
cp "scripts/defaults/${NETWORK_STATE_DEFAULTS_FILE}" "${NETWORK_STATE_FILE}"

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=scratch/steps.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
