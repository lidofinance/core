#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=${NETWORK:="hoodi"}  # if defined use the value set to default otherwise
export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}  # if defined use the value set to default otherwise

export DEPLOYER=${DEPLOYER:="0x26EDb7f0f223A25EE390aCCccb577F3a31edDfC5"}  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100
# https://github.com/eth-clients/hoodi?tab=readme-ov-file#metadata
export GENESIS_TIME=1742213400

export NETWORK_STATE_FILE=${NETWORK_STATE_FILE:="deployed-hoodi.json"}
export STEPS_FILE=upgrade/steps-upgrade-hoodi-patch-1.json
export UPGRADE_PARAMETERS_FILE=scripts/upgrade/upgrade-params-hoodi.toml

yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts
