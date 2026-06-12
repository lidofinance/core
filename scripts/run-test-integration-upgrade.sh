#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/common-env.sh

load_env_var NETWORK || {
  echo "Error: NETWORK must be set"
  exit 1
}
echo "NETWORK: $NETWORK"

# Derive RPC_URL from <NETWORK>_RPC_URL if not set explicitly
load_env_var RPC_URL || {
  RPC_VAR="${NETWORK^^}_RPC_URL"

  load_env_var "$RPC_VAR" || {
    echo "Error: RPC_URL or ${RPC_VAR} must be set"
    exit 1
  }
  echo "Derive RPC_URL from ${RPC_VAR}"
  export RPC_URL="${!RPC_VAR:-}"
}
# echo "RPC_URL: $RPC_URL"

# Set default to local test deployer
load_env_var DEPLOYER "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "DEPLOYER: $DEPLOYER"

load_env_var HOLDER
if [[ -n ${HOLDER:-} ]]; then
  echo "HOLDER: $HOLDER"
fi

load_env_var NETWORK_STATE_FILE "deployed-${NETWORK}.json"
if [[ ! -f $NETWORK_STATE_FILE ]]; then
  echo "Error: Network state file not found: $NETWORK_STATE_FILE"
  exit 1
fi
echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"

# Upgrade parameters file
load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${NETWORK}.toml"
if [[ ! -f $UPGRADE_PARAMETERS_FILE ]]; then
  echo "Error: Upgrade params file not found: $UPGRADE_PARAMETERS_FILE"
  exit 1
fi
echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"

load_env_var STEPS_FILE "upgrade/steps-mock-upgrade.json"
echo "STEPS_FILE: $STEPS_FILE"

TEMP_NETWORK_STATE_FILE="deployed-${NETWORK}-upgrade.json"
cp -f "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
export NETWORK_STATE_FILE=$TEMP_NETWORK_STATE_FILE

TEMP_UPGRADE_PARAMETERS_FILE="upgrade-params-${NETWORK}-upgrade.toml"
cp -f "$UPGRADE_PARAMETERS_FILE" "$TEMP_UPGRADE_PARAMETERS_FILE"
export UPGRADE_PARAMETERS_FILE=$TEMP_UPGRADE_PARAMETERS_FILE

load_env_var FORKING_BLOCK_NUMBER
if [[ -n ${FORKING_BLOCK_NUMBER:-} ]]; then
  echo "FORKING_BLOCK_NUMBER: ${FORKING_BLOCK_NUMBER}"
fi

export ALLOW_SKIP_STEPS=1
export AUTO_CONFIRM=1
# load_env_var TEMPLATE_TEST "false"
export GAS_LIMIT=16000000
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

yarn hardhat test test/integration/**/*.ts --trace --disabletracer
