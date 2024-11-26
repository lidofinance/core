#!/bin/bash
set -e +u
set -o pipefail

# Check for required environment variables
if [[ -z "${DEPLOYER}" ]]; then
  echo "Error: Environment variable DEPLOYER must be set"
  exit 1
fi
echo "DEPLOYER is $DEPLOYER"

if [[ -z "${NETWORK}" ]]; then
  echo "Error: Environment variable NETWORK must be set"
  exit 1
fi
echo "NETWORK is $NETWORK"

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=upgrade/steps.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
