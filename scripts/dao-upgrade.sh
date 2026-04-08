#!/bin/bash
set -e +u
set -o pipefail

# Check for required environment variables
if [[ -z ${DEPLOYER} ]]; then
  echo "Error: Environment variable DEPLOYER must be set"
  exit 1
fi
echo "DEPLOYER is $DEPLOYER"

if [[ -z ${NETWORK} ]]; then
  echo "Error: Environment variable NETWORK must be set"
  exit 1
fi
echo "NETWORK is $NETWORK"

# Compile contracts
echo "Compiling contracts..."
yarn compile

# Generic migration steps files
export NETWORK_STATE_FILE=${NETWORK_STATE_FILE:="deployed-${NETWORK}.json"}
export UPGRADE_PARAMETERS_FILE=${UPGRADE_PARAMETERS_FILE:="scripts/upgrade/upgrade-params-${NETWORK}.toml"}

export STEPS_FILE=${STEPS_FILE:="upgrade/steps-upgrade.json"}

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts

# TODO
# yarn hardhat --network $NETWORK run --no-compile scripts/scratch/steps/90-check-dao.ts
