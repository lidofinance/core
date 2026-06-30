#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

prepare_local_fork_files() {
  load_env_var NETWORK_STATE_FILE "deployed-${NETWORK}.json"
  load_env_var UPGRADE_PARAMETERS_FILE "scripts/upgrade/upgrade-params-${NETWORK}.toml"

  local temp_network_state_file="deployed-local.json"
  local temp_upgrade_parameters_file="scripts/upgrade/upgrade-params-local.toml"

  rm -f "$temp_network_state_file"
  rm -f "$temp_upgrade_parameters_file"

  if [[ -f $NETWORK_STATE_FILE ]]; then
    cp "$NETWORK_STATE_FILE" "$temp_network_state_file"
    echo "$NETWORK_STATE_FILE ==> $temp_network_state_file"
    export NETWORK_STATE_FILE=$temp_network_state_file
  fi

  if [[ -f $UPGRADE_PARAMETERS_FILE ]]; then
    cp "$UPGRADE_PARAMETERS_FILE" "$temp_upgrade_parameters_file"
    echo "$UPGRADE_PARAMETERS_FILE ==> $temp_upgrade_parameters_file"
    export UPGRADE_PARAMETERS_FILE=$temp_upgrade_parameters_file
  fi

  echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"
  echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"
}

load_env_var MODE "forking"
load_env_var HARDHAT_NODE_DOCKER_IMAGE_REPOSITORY "ghcr.io/lidofinance/hardhat-node"
load_env_var HARDHAT_NODE_DOCKER_IMAGE_VERSION "2.28.0"
load_env_var HARDHAT_NODE_DOCKER_NAME "hardhat-node"
load_env_var HARDHAT_NODE_DOCKER_PORT "8545"

echo "MODE: $MODE"
echo "HARDHAT_NODE_DOCKER_IMAGE_VERSION: $HARDHAT_NODE_DOCKER_IMAGE_VERSION"

DOCKER_ENV_ARGS=()

case "$MODE" in
  scratch)
    IMAGE="${HARDHAT_NODE_DOCKER_IMAGE_REPOSITORY}:${HARDHAT_NODE_DOCKER_IMAGE_VERSION}-scratch"
    ;;
  forking)
    load_env_var NETWORK || {
      echo "Error: NETWORK must be set for MODE=forking"
      exit 1
    }
    echo "NETWORK: $NETWORK"

    case "$NETWORK" in
      mainnet)
        IMAGE="${HARDHAT_NODE_DOCKER_IMAGE_REPOSITORY}:${HARDHAT_NODE_DOCKER_IMAGE_VERSION}"
        ;;
      hoodi)
        IMAGE="${HARDHAT_NODE_DOCKER_IMAGE_REPOSITORY}:${HARDHAT_NODE_DOCKER_IMAGE_VERSION}-hoodi"
        ;;
      *)
        echo "Error: MODE=forking supports only NETWORK=mainnet or NETWORK=hoodi"
        exit 1
        ;;
    esac

    derive_rpc_url "$NETWORK"
    DOCKER_ENV_ARGS=(-e "ETH_RPC_URL=$RPC_URL")

    load_env_var FORKING_BLOCK_NUMBER ""
    if [[ -n ${FORKING_BLOCK_NUMBER:-} ]]; then
      echo "FORKING_BLOCK_NUMBER: ${FORKING_BLOCK_NUMBER}"
      DOCKER_ENV_ARGS+=(-e "FORKING_BLOCK_NUMBER=$FORKING_BLOCK_NUMBER")
    fi

    prepare_local_fork_files
    ;;
  *)
    echo "Error: MODE must be either 'forking' or 'scratch'"
    exit 1
    ;;
esac

echo "IMAGE: $IMAGE"
echo "PORT: $HARDHAT_NODE_DOCKER_PORT"

cleanup() {
  echo "Cleaning up $HARDHAT_NODE_DOCKER_NAME..."
  docker rm -f "$HARDHAT_NODE_DOCKER_NAME" >/dev/null 2>&1 || true
}

trap cleanup INT TERM EXIT

cleanup

docker run \
  -it --rm \
  --name "$HARDHAT_NODE_DOCKER_NAME" \
  -p "$HARDHAT_NODE_DOCKER_PORT:8545" \
  "${DOCKER_ENV_ARGS[@]}" \
  "$IMAGE"
