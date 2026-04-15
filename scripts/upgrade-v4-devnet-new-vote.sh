#!/bin/bash
set -e +u
set -o pipefail

. .env.devnet

export NETWORK=local-devnet

export LOCAL_RPC_URL=${LOCAL_RPC_URL:="http://127.0.0.1:8545"}
export DEPLOYER=${DEPLOYER:="0x8943545177806ED17B9F23F0a21ee5948eCaa776"}
export LOCAL_DEVNET_PK=${LOCAL_DEVNET_PK:=""}

export NETWORK_STATE_FILE="deployed-devnet1.json"
export UPGRADE_PARAMETERS_FILE="scripts/upgrade/upgrade-params-devnet1.toml"
export STEPS_FILE="upgrade/steps-upgrade-v4-devnet-new-vote.json"

export VOTE_DESCRIPTION="upgrade-v4-devnet"
export PROPOSAL_METADATA="upgrade-v4-devnet"
export PROPOSAL_ID=${PROPOSAL_ID:=""}

bash scripts/dao-upgrade.sh
