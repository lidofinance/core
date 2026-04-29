#!/usr/bin/env bash
set -e +u
set -o pipefail

if [ -f .env ]; then
  . .env
fi

if [[ -z ${NETWORK} ]]; then
  echo "Error: Environment variable NETWORK must be set"
  exit 1
fi
echo "NETWORK: $NETWORK"

# Derive RPC_URL from <NETWORK>_RPC_URL if not set explicitly
if [[ -z ${RPC_URL} ]]; then
  RPC_VAR="${NETWORK^^}_RPC_URL"
  RPC_URL="${!RPC_VAR}"
  if [[ -z ${RPC_URL} ]]; then
    echo "Error: RPC_URL is not set and ${RPC_VAR} is also not set"
    exit 1
  fi
  echo "RPC_URL derived from \${${RPC_VAR}}"
  export RPC_URL
fi
# echo "RPC_URL: $RPC_URL"

# Set default to local test deployer
export DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
echo "DEPLOYER: $DEPLOYER"

# Generic migration steps files
export NETWORK_STATE_FILE=${NETWORK_STATE_FILE:="deployed-${NETWORK}.json"}
if [[ ! -f $NETWORK_STATE_FILE ]]; then
  echo "Error: Network state file not found: $SOURCE_NETWORK_STATE_FILE"
  exit 1
fi
echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"

# Upgrade parameters file
export UPGRADE_PARAMETERS_FILE=${UPGRADE_PARAMETERS_FILE:="scripts/upgrade/upgrade-params-${NETWORK}.toml"}
if [[ ! -f $UPGRADE_PARAMETERS_FILE ]]; then
  echo "Error: Upgrade params file not found: $UPGRADE_PARAMETERS_FILE"
  exit 1
fi
echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"

export STEPS_FILE=${STEPS_FILE:="upgrade/steps-mock-upgrade.json"}
echo "STEPS_FILE: $STEPS_FILE"

TEMP_NETWORK_STATE_FILE="deployed-${NETWORK}-upgrade.json"
cp -f "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
export NETWORK_STATE_FILE=$TEMP_NETWORK_STATE_FILE

TEMP_UPGRADE_PARAMETERS_FILE="upgrade-params-${NETWORK}-upgrade.toml"
cp -f "$UPGRADE_PARAMETERS_FILE" "$TEMP_UPGRADE_PARAMETERS_FILE"
export UPGRADE_PARAMETERS_FILE=$TEMP_UPGRADE_PARAMETERS_FILE

export ALLOW_SKIP_STEPS=1
export AUTO_CONFIRM=1
export TEMPLATE_TEST=${TEMPLATE_TEST=true:="false"}
export GAS_LIMIT=16000000
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

yarn hardhat test test/integration/**/*.ts --trace --disabletracer
