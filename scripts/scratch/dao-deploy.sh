#!/bin/bash
set -e +u
set -o pipefail

ARAGON_APPS_REPO_REF=import-shared-minime

if [[ -z "${DEPLOYER}" ]]; then
  echo "Env variable DEPLOYER must be set"
  exit 1
fi
echo "DEPLOYER is $DEPLOYER"

if [[ -z "${NETWORK}" ]]; then
  echo "Env variable NETWORK must be set"
  exit 1
fi
echo "NETWORK is $NETWORK"

function msg() {
  MSG=$1
  if [ ! -z "$MSG" ]; then
    echo ">>> ============================="
    echo ">>> $MSG"
    echo ">>> ============================="
  fi
}


rm -f ${NETWORK_STATE_FILE}
cp ${NETWORK_STATE_DEFAULTS_FILE} ${NETWORK_STATE_FILE}

npm run compile

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/00-populate-deploy-artifact-from-env.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/01-deploy-deposit-contract.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/02-deploy-aragon-env.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/03-deploy-template-and-app-bases.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/04-register-ens-domain.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/05-deploy-apm.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/06-create-app-repos.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/07-deploy-dao.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/08-issue-tokens.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/09-deploy-non-aragon-contracts.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/10-gate-seal.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/11-finalize-dao.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/12-initialize-non-aragon-contracts.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/13-grant-roles.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/14-plug-curated-staking-module.ts

npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/15-transfer-roles.ts

# TODO
# npm run hardhat --network $NETWORK run --no-compile scripts/scratch/steps/90-check-dao.ts
