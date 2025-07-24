# Start hardhat in background (suppress output)
yarn hardhat node --port 8545 --fork http://hr6vb81d1ndsx-rpc-3-mainnet-erigon.tooling-nodes.testnet.fi > /dev/null 2>&1 &
HARDHAT_PID=$!

# Cleanup function to kill hardhat on exit
cleanup() {
    echo "Stopping hardhat..."
    kill $HARDHAT_PID 2>/dev/null
    wait $HARDHAT_PID 2>/dev/null
}

# Set trap to cleanup on script exit
trap cleanup EXIT

# Wait for hardhat to start
sleep 5

export RPC_URL=${RPC_URL:="http://127.0.0.1:8545"}  # if defined use the value set to default otherwise
export SLOTS_PER_EPOCH=32
export GENESIS_TIME=1606824023  # just some time
# export WITHDRAWAL_QUEUE_BASE_URI="<< SET IF REQUIED >>"
# export DSM_PREDEFINED_ADDRESS="<< SET IF REQUIED >>"

export DEPLOYER=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266  # first acc of default mnemonic "test test ..."
export GAS_PRIORITY_FEE=1
export GAS_MAX_FEE=100

export NETWORK_STATE_FILE=deployed-mainnet-upgrade.json

cp deployed-mainnet.json $NETWORK_STATE_FILE

yarn upgrade:deploy
yarn upgrade:mock-voting
# cp  $NETWORK_STATE_FILE deployed-mainnet.json
# yarn hardhat --network custom run --no-compile scripts/utils/mine.ts
yarn test:integration
