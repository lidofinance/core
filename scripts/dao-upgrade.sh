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

# Generic migration steps files
export NETWORK_STATE_FILE=${NETWORK_STATE_FILE-"deployed-${NETWORK}.json"}
echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"
# Upgrade parameters file
export UPGRADE_PARAMETERS_FILE=${UPGRADE_PARAMETERS_FILE-"scripts/upgrade/upgrade-params-${NETWORK}.toml"}
echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"
export STEPS_FILE=${STEPS_FILE-"upgrade/steps-upgrade.json"}
echo "STEPS_FILE: $STEPS_FILE"

if [[ ${MODE:-} == "forking" ]]; then
  echo "MODE: forking!"

  if [[ -f $NETWORK_STATE_FILE ]]; then
    TEMP_NETWORK_STATE_FILE="deployed-local.json"
    if [[ ! -f $TEMP_NETWORK_STATE_FILE ]]; then
      cp "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
      echo "Copied $NETWORK_STATE_FILE to $TEMP_NETWORK_STATE_FILE"
    fi
    export NETWORK_STATE_FILE="deployed-local.json"
  fi

  if [[ -f $UPGRADE_PARAMETERS_FILE ]]; then
    TEMP_UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-local.toml"
    if [[ ! -f $TEMP_UPGRADE_PARAMETERS_FILE ]]; then
      cp "$UPGRADE_PARAMETERS_FILE" "$TEMP_UPGRADE_PARAMETERS_FILE"
      echo "Copied $UPGRADE_PARAMETERS_FILE to $TEMP_UPGRADE_PARAMETERS_FILE"
    fi
    export UPGRADE_PARAMETERS_FILE=$TEMP_UPGRADE_PARAMETERS_FILE
  fi

  export NETWORK="local"
  export LOCAL_RPC_URL="http://localhost:8545"
  export HOLDER=${HOLDER-"${DEPLOYER}"}
  echo "HOLDER: $HOLDER"
  export DEPLOYER="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
  export ALLOW_SKIP_STEPS=${ALLOW_SKIP_STEPS-"true"}
  echo "ALLOW_SKIP_STEPS: $ALLOW_SKIP_STEPS"
  export AUTO_CONFIRM=${AUTO_CONFIRM-"false"}
  echo "AUTO_CONFIRM: $AUTO_CONFIRM"
  # export GAS_LIMIT=16000000
  export GAS_PRIORITY_FEE=1
  export GAS_MAX_FEE=100
fi

# Set default to local test deployer
export DEPLOYER=${DEPLOYER-"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}
echo "DEPLOYER: $DEPLOYER"

echo "Compiling contracts..."
yarn hardhat compile

echo "Starting migration..."
yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrate.ts

# Need this to get sure the last transactions are mined
# yarn hardhat --network $NETWORK run --no-compile scripts/utils/mine.ts
