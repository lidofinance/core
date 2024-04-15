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

pnpm compile

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/00-populate-deploy-artifact-from-env.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/01-deploy-deposit-contract.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/02-deploy-aragon-env.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/03-deploy-template-and-app-bases.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/04-register-ens-domain.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/05-deploy-apm.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/06-create-app-repos.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/07-deploy-dao.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/08-issue-tokens.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/09-deploy-non-aragon-contracts.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/10-gate-seal.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/11-finalize-dao.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/12-initialize-non-aragon-contracts.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/13-grant-roles.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/14-plug-curated-staking-module.ts

pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/15-transfer-roles.ts

# TODO
# pnpm hardhat --network $NETWORK run --no-compile scripts/scratch/steps/90-check-dao.ts
