#!/bin/bash
set -e +u
set -o pipefail

export NETWORK=local
export RPC_URL=${RPC_URL:="http://127.0.0.1:8555"}  # if defined use the value set to default otherwise

export GENESIS_TIME=1639659600  # just some time
# export WITHDRAWAL_QUEUE_BASE_URI="<< SET IF REQUIRED >>"
# export DSM_PREDEFINED_ADDRESS="<< SET IF REQUIRED >>"

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE="deployed-${NETWORK}.json"
export SCRATCH_DEPLOY_CONFIG="scripts/scratch/deploy-params-testnet.toml"

bash scripts/dao-deploy.sh

# Need this to get sure the last transactions are mined
yarn hardhat --network $NETWORK run --no-compile scripts/utils/mine.ts

# Run acceptance tests
# dao-deploy.sh exports SKIP_GAS_REPORT only inside its own (child) shell, so
# set it here too — otherwise the test phase prints the full gas table.
export SKIP_GAS_REPORT=${SKIP_GAS_REPORT-true}  # re-enable with SKIP_GAS_REPORT=""
export INTEGRATION_WITH_CSM="off"
yarn test:integration:fork:local
