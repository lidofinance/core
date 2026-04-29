#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/common-env.sh

load_env_var NETWORK || {
  echo "Error: NETWORK must be set"
  exit 1
}
echo "NETWORK: $NETWORK"

if [[ ${NETWORK:-} == "local" ]]; then
  echo "Error: Network cannot be 'local'"
  exit 1
fi

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

load_env_var NETWORK_STATE_FILE "deployed-${NETWORK}.json"
echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"

load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${NETWORK}.toml"
echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"

TEMP_NETWORK_STATE_FILE="deployed-local.json"
TEMP_UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-local.toml"

if [[ -f $TEMP_NETWORK_STATE_FILE ]]; then
  rm -f $TEMP_NETWORK_STATE_FILE
fi

if [[ -f $TEMP_UPGRADE_PARAMETERS_FILE ]]; then
  rm -f $TEMP_UPGRADE_PARAMETERS_FILE
fi

if [[ -f $NETWORK_STATE_FILE ]]; then
  cp "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
  echo "Copied $NETWORK_STATE_FILE to $TEMP_NETWORK_STATE_FILE"
  export NETWORK_STATE_FILE=$TEMP_NETWORK_STATE_FILE
fi

if [[ -f $UPGRADE_PARAMETERS_FILE ]]; then
  cp "$UPGRADE_PARAMETERS_FILE" "$TEMP_UPGRADE_PARAMETERS_FILE"
  echo "Copied $UPGRADE_PARAMETERS_FILE to $TEMP_UPGRADE_PARAMETERS_FILE"
  export UPGRADE_PARAMETERS_FILE=$TEMP_UPGRADE_PARAMETERS_FILE
fi

FORK_NODE=${FORK_NODE:-anvil}
echo "FORK_NODE: $FORK_NODE"

BLOCK_ARG=()
if [[ -n ${FORKING_BLOCK_NUMBER:-} ]]; then
  echo "FORKING_BLOCK_NUMBER: ${FORKING_BLOCK_NUMBER}"
  BLOCK_ARG=(--fork-block-number "$FORKING_BLOCK_NUMBER")
fi

if [[ ${FORK_NODE:-} == "anvil" ]]; then
  # --config-out localhost.json
  anvil -f $RPC_URL "${BLOCK_ARG[@]}" --timeout 90000 --print-traces --steps-tracing --auto-impersonate
else
  yarn hardhat node --fork $RPC_URL "${BLOCK_ARG[@]}" --nocompile --trace --gascost --vvv
fi
