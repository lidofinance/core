#!/bin/bash
set -e +u
set -o pipefail

# TODO: Do we still need to set these variable?
# ARAGON_APPS_REPO_REF=import-shared-minime

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

rm -f "${NETWORK_STATE_FILE}"
cp "${NETWORK_STATE_DEFAULTS_FILE}" "${NETWORK_STATE_FILE}"

# Compile contracts
yarn compile

# Generic migration steps file
export STEPS_FILE=scratch/steps.json

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts

# TODO
# yarn hardhat --network $NETWORK run --no-compile scripts/scratch/steps/90-check-dao.ts
