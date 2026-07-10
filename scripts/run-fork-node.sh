#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

load_env_var NETWORK || {
  echo "Error: NETWORK must be set"
  exit 1
}
echo "NETWORK: $NETWORK"

if [[ $NETWORK == "local" || $NETWORK == "hardhat" ]]; then
  echo "Error: Network cannot be $(${NETWORK})"
  exit 1
fi

derive_rpc_url "$NETWORK"
# echo "RPC_URL: $RPC_URL"

load_env_var NETWORK_STATE_FILE "deployed-${NETWORK}.json"
load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${NETWORK}.toml"

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

echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"
echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"

load_env_var FORK_NODE "anvil"
load_env_var TRACE ""

BLOCK_ARG=()
load_env_var FORKING_BLOCK_NUMBER ""
if [[ -n ${FORKING_BLOCK_NUMBER:-} ]]; then
  echo "FORKING_BLOCK_NUMBER: ${FORKING_BLOCK_NUMBER}"
  BLOCK_ARG=(--fork-block-number "$FORKING_BLOCK_NUMBER")
fi

if [[ ${FORK_NODE:-} == "anvil" ]]; then
  if [[ -n ${TRACE:-} ]]; then
    anvil -f $RPC_URL "${BLOCK_ARG[@]}" --timeout 90000 --print-traces --steps-tracing --auto-impersonate
  else
    anvil -f $RPC_URL "${BLOCK_ARG[@]}" --timeout 90000 --auto-impersonate
  fi
else

  export HARDHAT_CHAIN_ID="$(cast chain-id --rpc-url "$RPC_URL")"
  echo "HARDHAT_CHAIN_ID: $HARDHAT_CHAIN_ID"

  if [[ -n ${TRACE:-} ]]; then
    yarn hardhat node --fork $RPC_URL "${BLOCK_ARG[@]}" --nocompile --trace --gascost --vvv
  else
    yarn hardhat node --fork $RPC_URL "${BLOCK_ARG[@]}" --nocompile
  fi
fi
