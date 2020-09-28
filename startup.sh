#!/bin/bash
source ./.env
set -e +u
set -o pipefail

ROOT=${PWD}
LOCAL_DATA_DIR="${PWD}${DATADIR}"
LOCAL_VALIDATORS_DIR="${PWD}${VALIDATORS_DIR}"
LOCAL_MOCK_VALIDATORS_DIR="${PWD}${MOCK_VALIDATORS_DIR}"
LOCAL_MOCK_SECRETS_DIR="${PWD}${MOCK_SECRETS_DIR}"
LOCAL_TESTNET_DIR="${PWD}${TESTNET_DIR}"
LOCAL_DEVCHAIN_DIR="${LOCAL_DATA_DIR}/devchain"

while test $# -gt 0; do
  case "$1" in
    -h|--help)
      echo " = run eth1<->eth2 testnet = "
      echo " "
      echo "$0 [options]"
      echo " "
      echo "options:"
      echo "  -h | --help           show this help"
      echo "  -r | --reset          force reset all blockchains state (clear all data)"
      echo "  -d | --dao            force try to deploy dao"
      echo "  -r2 | --reset2        force reset ETH2 blockchain state"
      echo "  -n | --nodes          start 2nd and 3d eth2 nodes"
      echo "  -s | --snapshot       use snapshot instead deploy"
      echo "  -1 | --eth1           start only eth1 node"
      exit 0
      ;;
    -r|--reset)
      RESET=true
      shift
      ;;
    -n|--nodes)
      NODES=true
      shift
      ;;
    -s|--snapshot)
      SNAPSHOT=true
      shift
      ;;
    -1|--eth1)
      ETH1_ONLY=true
      shift
      ;;
    -r2|--reset2)
      ETH2_RESET=true
      shift
      ;;
    -d|--dao)
      DAO_DEPLOY=true
      shift
      ;;
    *)
      break
      ;;
  esac
done

if ! command -v jq >/dev/null; then
  echo 'Please install jq executable: https://stedolan.github.io/jq'
  exit 1
fi

if [[ $RESET ]]; then
  echo "Cleanup"
  docker-compose down -v --remove-orphans
  rm -rf $LOCAL_DATA_DIR
  mkdir -p $LOCAL_DATA_DIR
  if [[ $SNAPSHOT ]]; then
    echo "Unzip snapshot"
    unzip -o -q -d $LOCAL_DATA_DIR ./devchain.zip
    unzip -o -q -d $LOCAL_DATA_DIR ./ipfs.zip
  fi
  ETH2_RESET=true
  DAO_DEPLOY=true
fi

if [ ! -d $LOCAL_DEVCHAIN_DIR ]; then
  DAO_DEPLOY=true
fi

if [ ! -d $LOCAL_TESTNET_DIR ]; then
  ETH2_RESET=true
fi

echo "Starting IPFS"
docker-compose up -d ipfs
echo -n "Waiting for IPFS start"
while ! curl --output /dev/null -s -f -L http://localhost:8080/api/v0/version; do
  sleep 2 && echo -n .
done
echo " "

echo "Starting eth1 node"
docker-compose up -d node1

echo -n "Waiting for eth1 rpc"
while ! curl --output /dev/null -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'; do
  sleep 2 && echo -n .
done
#sleep 3
#R="0x"
#while [[ "$R" != "0x60" ]];
#do
#  R=$(curl -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x'$DEPOSIT'","latest"],"id":1}' | jq -r '.result'  | cut -c -4)
#  sleep 2 && echo -n .
#done
echo " "
if [[ ! $SNAPSHOT ]] && [[ $DAO_DEPLOY ]] ; then
  R=$(curl -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x'$DEPOSIT'","latest"],"id":1}' | jq -r '.result'  | cut -c -4)
  if [[ "$R" != "0x60" ]]; then
    echo "Deploying deposit contract..."
    ADMIN="$(curl -s -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_accounts","params":[],"id":1}' | jq -r '.result[0]')"
    echo "Owner: $ADMIN"
    CODE=$(curl -s https://raw.githubusercontent.com/ethereum/eth2.0-specs/dev/solidity_deposit_contract/deposit_contract.json | jq -r '.bytecode' | cut -c 3-)
    # send deploy deposit contract tx, gasPrice = 20gwei
    HASH=$(curl -s -L -X POST http://localhost:8545 \
      --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_sendTransaction\",\"params\":[{
      \"from\": \"$ADMIN\",
      \"gas\": \"0x20acc4\",
      \"gasPrice\": \"0x4a817c800\",
      \"value\": \"0x00\",
      \"data\": \"$CODE\"
    }],\"id\":1}" | jq -r '.result')
    echo "Tx hash: $HASH"
    # wait a bit for block mined
    sleep 3
    R=$(curl -s -L -X POST http://localhost:8545 --data "{\"jsonrpc\":\"2.0\",\"method\":\"eth_getTransactionReceipt\",\"params\":[\"$HASH\"],\"id\":1}")
  #  HASH=$(echo "$R" | jq -r '.result.txHash')
    BLOCK_HEX=$(echo "$R" | jq -r '.result.blockNumber' | cut -c 3-)
    BLOCK=$((16#$BLOCK_HEX))
    ADDR=$(echo "$R" | jq -r '.result.contractAddress')
    echo "Deposit contract deployed: $ADDR at block $BLOCK"
  fi

  R=$(curl -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x'$APM'","latest"],"id":1}' | jq -r '.result'  | cut -c -4)
  if [[ "$R" != "0x60" ]]; then
    echo "Deploying DePool APM..."
    npm run deploy:apm:dev
  fi
  R=$(curl -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x'$DEPOOL_APP'","latest"],"id":1}' | jq -r '.result'  | cut -c -4)
  if [[ "$R" != "0x60" ]]; then
    echo "Deploying DePool Apps..."
    npm run deploy:apps:dev
  fi
  R=$(curl -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x'$TEMPLATE'","latest"],"id":1}' | jq -r '.result'  | cut -c -4)
  if [[ "$R" != "0x60" ]]; then
    echo "Deploying DePool DAO template..."
    npm run deploy:tmpl:dev
  fi
  R=$(curl -s -f -L -X POST http://localhost:8545 --data '{"jsonrpc":"2.0","method":"eth_getCode","params":["0x'$DAO'","latest"],"id":1}' | jq -r '.result'  | cut -c -4)
  if [[ "$R" != "0x60" ]]; then
    echo "Deploying DePool DAO..."
    npm run deploy:dao:dev
  fi
  # wait a bit for block mining
  sleep 3
else
  echo "DevChain data exists"
  echo "Deposit contract predeployed: 0x$DEPOSIT at block $BLOCK"
  echo "DAO deployed at: 0x$DAO"
fi

echo "Starting Aragon web UI"
docker-compose up -d aragon

if [[ $ETH1_ONLY ]]; then
  exit 0
fi

if [ $ETH2_RESET ]; then
  if [ ! $RESET ]; then
    docker-compose stop node2-1
    docker-compose rm -f node2-1
    docker-compose stop genesis-validators
    docker-compose rm -f genesis-validators
    docker-compose stop validators
    docker-compose rm -f validators
  fi

  rm -rf $LOCAL_TESTNET_DIR
  docker-compose run --rm --no-deps node2-1 lcli \
    --spec "$SPEC" \
    new-testnet \
    --deposit-contract-address "$DEPOSIT" \
    --deposit-contract-deploy-block "$BLOCK" \
    --testnet-dir "$TESTNET_DIR" \
    --force \
    --min-genesis-active-validator-count "$MOCK_VALIDATOR_COUNT" \
    --eth1-follow-distance "$ETH1_FOLLOW_DISTANCE" \
    --genesis-delay "$GENESIS_DELAY" \
    --genesis-fork-version "$FORK_VERSION"

  # overwrite some params in config
  #cp -f ./config.yaml $LOCAL_TESTNET_DIR

  if [ $SPEC = "minimal" ]; then
    # reduce slot time generation
    sed -i '' 's/SECONDS_PER_SLOT: 6/SECONDS_PER_SLOT: 1/' $LOCAL_TESTNET_DIR/config.yaml
    # set according eth1 block time generation, see docker-compose.yml
    sed -i '' 's/SECONDS_PER_ETH1_BLOCK: 14/SECONDS_PER_ETH1_BLOCK: 2/' $LOCAL_TESTNET_DIR/config.yaml
  fi

  echo "Specification generated at $LOCAL_TESTNET_DIR."

  echo "Generating $MOCK_VALIDATOR_COUNT mock validators concurrently... (this may take a while)"
  rm -rf $LOCAL_MOCK_VALIDATORS_DIR
  rm -rf $LOCAL_MOCK_SECRETS_DIR
  docker-compose run --rm --no-deps node2-1 lcli \
    --spec "$SPEC" \
    insecure-validators \
    --count $MOCK_VALIDATOR_COUNT \
    --validators-dir $MOCK_VALIDATORS_DIR \
    --secrets-dir $MOCK_SECRETS_DIR

  echo "Validators generated at $MOCK_VALIDATORS_DIR with keystore passwords at $MOCK_SECRETS_DIR."

  echo "Building genesis state... (this might take a while)"
  docker-compose run --rm --no-deps node2-1  lcli \
    --spec "$SPEC" \
    interop-genesis \
    --testnet-dir $TESTNET_DIR \
    --genesis-fork-version $FORK_VERSION \
    $MOCK_VALIDATOR_COUNT
  #
  echo "Created genesis state in $TESTNET_DIR"

  NOW=$(date +%s)
  echo "Reset genesis time to now ($NOW)"
  docker-compose run --rm --no-deps node2-1 lcli \
    --spec "$SPEC" \
    change-genesis-time \
    $TESTNET_DIR/genesis.ssz \
    $NOW
fi

if [[ $ETH1_ONLY ]]; then
  exit 0
fi

if [ ! -d "$LOCAL_VALIDATORS_DIR" ]; then
  unzip -o -q -d $LOCAL_DATA_DIR ./validators.zip
fi

docker-compose up -d node2-1
sleep 3
docker-compose up -d mock-validators
docker-compose up -d validators

if [[ $NODES ]]; then
  echo "Start extra nodes"
  sleep 3
  docker-compose up -d node2-2
  sleep 3
  docker-compose up -d node2-3
fi
