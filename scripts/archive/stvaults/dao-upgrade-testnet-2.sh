#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=hoodi
export NETWORK_STATE_FILE="deployed-${NETWORK}-vaults-testnet-2.json"

export GAS_PRIORITY_FEE=2

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=upgrade/steps-testnet-2.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
