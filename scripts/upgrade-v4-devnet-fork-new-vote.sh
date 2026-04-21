#!/bin/bash
set -e +u
set -o pipefail

. .env.devnet

# keep original deployer for voting and execution
export HOLDER=${DEPLOYER:="0x8943545177806ED17B9F23F0a21ee5948eCaa776"}

# override variables from .env.devnet for forking
export NETWORK=local
export LOCAL_RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}
export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 # first acc of default mnemonic "test test ..."
export MODE=forking

export STEPS_FILE="upgrade/steps-devnet-new-vote.json"
export VOTE_DESCRIPTION="upgrade-v4-devnet"
export PROPOSAL_METADATA="upgrade-v4-devnet"

bash scripts/dao-upgrade.sh
