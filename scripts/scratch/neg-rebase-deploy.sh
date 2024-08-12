#!/bin/bash
set -e +u
set -o pipefail

#
export NETWORK=local
# export NETWORK=sepolia
export RPC_URL=${RPC_URL:="http://127.0.0.1:8555"}  # if defined use the value set to default otherwise

export GENESIS_TIME=1639659600  # just some time

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
# export DEPLOYER=0x6885E36BFcb68CB383DfE90023a462C03BCB2AE5

export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100
#
export NETWORK_STATE_FILE="deployed-${NETWORK}.json"
export NETWORK_STATE_DEFAULTS_FILE="scripts/scratch/deployed-testnet-defaults.json"

if [[ -z "${DEPLOYER}" ]]; then
  echo "Env variable DEPLOYER must be set"
  exit 1
fi
echo "DEPLOYER is $DEPLOYER"

if [[ -z "${NETWORK}" ]]; then
  echo "Env variable NETWORK must be set"
  exit 1
fi
echo "NETWORK is $NETWORK"

function msg() {
  MSG=$1
  if [ ! -z "$MSG" ]; then
    echo ">>> ============================="
    echo ">>> $MSG"
    echo ">>> ============================="
  fi
}


rm -f ${NETWORK_STATE_FILE}
cp ${NETWORK_STATE_DEFAULTS_FILE} ${NETWORK_STATE_FILE}

yarn compile

rm -f ${NETWORK_STATE_FILE}
cp ${NETWORK_STATE_DEFAULTS_FILE} ${NETWORK_STATE_FILE}

yarn compile
yarn hardhat --network $NETWORK run --no-compile scripts/scratch/steps/00-populate-deploy-artifact-from-env.ts
yarn hardhat --network $NETWORK run --no-compile scripts/scratch/neg-rebase-sanity-checker-deploy.ts
