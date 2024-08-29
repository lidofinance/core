#!/bin/bash
set -e +u
set -o pipefail

# TODO: Do we still need to set these variable?
# ARAGON_APPS_REPO_REF=import-shared-minime

# Check for required environment variables
if [[ -z "${DEPLOYER}" ]]; then
  echo "Error: Environment variable DEPLOYER must be set"
  exit 1
fi
echo "DEPLOYER is $DEPLOYER"

if [[ -z "${NETWORK}" ]]; then
  echo "Error: Environment variable NETWORK must be set"
  exit 1
fi
echo "NETWORK is $NETWORK"

rm -f "${NETWORK_STATE_FILE}"
cp "${NETWORK_STATE_DEFAULTS_FILE}" "${NETWORK_STATE_FILE}"

# Compile contracts
yarn compile

# Define an array of deployment steps
DEPLOYMENT_STEPS=(
  "scratch/steps/00-populate-deploy-artifact-from-env.ts"
  "scratch/steps/01-deploy-deposit-contract.ts"
  "scratch/steps/02-deploy-aragon-env.ts"
  "scratch/steps/03-deploy-template-and-app-bases.ts"
  "scratch/steps/04-register-ens-domain.ts"
  "scratch/steps/05-deploy-apm.ts"
  "scratch/steps/06-create-app-repos.ts"
  "scratch/steps/07-deploy-dao.ts"
  "scratch/steps/08-issue-tokens.ts"
  "scratch/steps/09-deploy-non-aragon-contracts.ts"
  "scratch/steps/10-gate-seal.ts"
  "scratch/steps/11-finalize-dao.ts"
  "scratch/steps/12-initialize-non-aragon-contracts.ts"
  "scratch/steps/13-grant-roles.ts"
  "scratch/steps/14-plug-curated-staking-module.ts"
  "scratch/steps/15-transfer-roles.ts"
)

# Execute each deployment step
for step in "${DEPLOYMENT_STEPS[@]}"; do
  STEP=$step yarn hardhat --network $NETWORK run --no-compile scripts/utils/migrator.ts
done

# TODO
# yarn hardhat --network $NETWORK run --no-compile scripts/scratch/steps/90-check-dao.ts
