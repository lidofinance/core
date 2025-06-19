#!/bin/bash
#
# This script is similar in operation to .github/workflows/tests-integration-mainnet.yml
# and designed for running upgrade + mock + integration tests on a local fork
#
set -e +u
set -o pipefail

export RPC_URL=http://localhost:8555
export NETWORK_STATE_FILE=deployed-mainnet-upgrade.json

cp deployed-mainnet.json $NETWORK_STATE_FILE

# DEPLOYER is the default unlocked account
GAS_PRIORITY_FEE=1 \
GAS_MAX_FEE=100 \
DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 \
GENESIS_TIME=1606824023 \
yarn upgrade:deploy

yarn upgrade:mock-voting

yarn hardhat --network local run --no-compile scripts/utils/mine.ts

yarn test:integration
