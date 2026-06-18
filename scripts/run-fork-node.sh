#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

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

rm -f $TEMP_NETWORK_STATE_FILE
rm -f $TEMP_UPGRADE_PARAMETERS_FILE

if [[ -f $NETWORK_STATE_FILE ]]; then
  cp "$NETWORK_STATE_FILE" "$TEMP_NETWORK_STATE_FILE"
  echo "$NETWORK_STATE_FILE ==> $TEMP_NETWORK_STATE_FILE"
  export NETWORK_STATE_FILE=$TEMP_NETWORK_STATE_FILE
fi

if [[ -f $UPGRADE_PARAMETERS_FILE ]]; then
  cp "$UPGRADE_PARAMETERS_FILE" "$TEMP_UPGRADE_PARAMETERS_FILE"
  echo "$UPGRADE_PARAMETERS_FILE ==> $TEMP_UPGRADE_PARAMETERS_FILE"
  export UPGRADE_PARAMETERS_FILE=$TEMP_UPGRADE_PARAMETERS_FILE
fi

load_env_var FORK_NODE "anvil"
echo "FORK_NODE: $FORK_NODE"

load_env_var TRACE "false"

BLOCK_ARG=()
load_env_var FORKING_BLOCK_NUMBER ""
if [[ -n ${FORKING_BLOCK_NUMBER:-} ]]; then
  echo "FORKING_BLOCK_NUMBER: ${FORKING_BLOCK_NUMBER}"
  BLOCK_ARG=(--fork-block-number "$FORKING_BLOCK_NUMBER")
fi

if [[ ${FORK_NODE:-} == "anvil" ]]; then
  if [[ ${TRACE:-} == "true" ]]; then
    # --config-out localhost.json
    anvil -f $RPC_URL "${BLOCK_ARG[@]}" --timeout 90000 --print-traces --steps-tracing --auto-impersonate
  else
    anvil -f $RPC_URL "${BLOCK_ARG[@]}" --timeout 90000 --auto-impersonate
  fi
else
  if [[ ${TRACE:-} == "true" ]]; then
    yarn hardhat node --fork $RPC_URL "${BLOCK_ARG[@]}" --nocompile --trace --gascost --vvv
  else
    yarn hardhat node --fork $RPC_URL "${BLOCK_ARG[@]}" --nocompile
  fi
fi
