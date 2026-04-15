#!/bin/bash
set -e +u
set -o pipefail

export SKIP_INTERFACES_CHECK=1
export SKIP_LINT_SOLIDITY=1
export SKIP_GAS_REPORT=1
export SKIP_CONTRACT_SIZE=1

export LOCAL_DEVNET_PK="0xbcdf20249abf0ed6d944c0288fad489e33f66b3960d9e6229c1cd214ed3bbe31"

export NETWORK=local-devnet
export LOCAL_RPC_URL="http://hr6vb82d1ndsx-execution.main-with-easytrack.valset-03.testnet.fi" # if defined use the value set to default otherwise

export DEPLOYER=0x8943545177806ED17B9F23F0a21ee5948eCaa776 # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE="deployed-devnet1.json"

export UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-devnet1.toml"
export STEPS_FILE="upgrade/steps-upgrade-base.json"

bash scripts/dao-upgrade.sh
