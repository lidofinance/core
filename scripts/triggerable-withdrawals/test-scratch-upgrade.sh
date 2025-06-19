# RPC_URL: http://localhost:8555
#           DEPLOYER: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266" # first acc of default mnemonic "test test ..."
#           GAS_PRIORITY_FEE: 1
#           GAS_MAX_FEE: 100
#           NETWORK_STATE_FILE: deployed-mainnet-upgrade.json
#           UPGRADE_PARAMETERS_FILE: upgrade-parameters-mainnet.json

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
