#!/bin/bash
set -e +u
set -o pipefail

# TODO: Do we still need to set these variable?
# ARAGON_APPS_REPO_REF=import-shared-minime
export NETWORK=sepolia
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}  # if defined use the value set to default otherwise

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
# export DEPLOYER=0x6885E36BFcb68CB383DfE90023a462C03BCB2AE5

export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100


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

# TODO
# yarn hardhat --network $NETWORK run --no-compile scripts/scratch/steps/90-check-dao.ts
