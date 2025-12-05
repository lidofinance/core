#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=${NETWORK:="hoodi"}  # if defined use the value set to default otherwise
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}  # if defined use the value set to default otherwise

export DEPLOYER=${DEPLOYER:="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE=${NETWORK_STATE_FILE:="deployed-hoodi.json"}
export STEPS_FILE=upgrade/steps-upgrade-hoodi-patch-2.json
export UPGRADE_PARAMETERS_FILE=scripts/upgrade/upgrade-params-hoodi.toml

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
