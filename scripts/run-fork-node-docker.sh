#!/usr/bin/env bash
set -e +u
set -o pipefail

. scripts/utils/migration-env.sh

load_env_var MODE "forking"
load_env_var HARDHAT_NODE_DOCKER_IMAGE_REPOSITORY "ghcr.io/lidofinance/hardhat-node"
load_env_var HARDHAT_NODE_DOCKER_IMAGE_VERSION "2.28.0"
load_env_var HARDHAT_NODE_DOCKER_NAME "hardhat-node"
load_env_var HARDHAT_NODE_DOCKER_PORT "8545"
load_env_var HARDHAT_NODE_DOCKER_NETWORK "lido"

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

    copy_network_state_file "$NETWORK" local true
    copy_upgrade_parameters_file "$NETWORK" local true
    echo "NETWORK_STATE_FILE: $NETWORK_STATE_FILE"
    echo "UPGRADE_PARAMETERS_FILE: $UPGRADE_PARAMETERS_FILE"
    ;;
  *)
    echo "Error: MODE must be either 'forking' or 'scratch'"
    exit 1
    ;;
esac

echo "IMAGE: $IMAGE"
echo "PORT: $HARDHAT_NODE_DOCKER_PORT"
echo "DOCKER_NETWORK: $HARDHAT_NODE_DOCKER_NETWORK"

ensure_docker_network() {
  if docker network inspect "$HARDHAT_NODE_DOCKER_NETWORK" >/dev/null 2>&1; then
    echo "Docker network exists: $HARDHAT_NODE_DOCKER_NETWORK"
  else
    echo "Creating Docker network: $HARDHAT_NODE_DOCKER_NETWORK"
    docker network create "$HARDHAT_NODE_DOCKER_NETWORK" >/dev/null
  fi
}

cleanup() {
  echo "Cleaning up $HARDHAT_NODE_DOCKER_NAME..."
  docker rm -f "$HARDHAT_NODE_DOCKER_NAME" >/dev/null 2>&1 || true
}

trap cleanup INT TERM EXIT

ensure_docker_network
cleanup

docker run \
  -it --rm \
  --name "$HARDHAT_NODE_DOCKER_NAME" \
  --network "$HARDHAT_NODE_DOCKER_NETWORK" \
  -p "$HARDHAT_NODE_DOCKER_PORT:8545" \
  "${DOCKER_ENV_ARGS[@]}" \
  "$IMAGE"
