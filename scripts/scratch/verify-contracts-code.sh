
#!/bin/bash
set -e
SCRIPT_DIR=$( cd -- "$( dirname -- "${BASH_SOURCE[0]}" )" &> /dev/null && pwd )

export NETWORK=sepolia
export RPC_URL=https://sepolia.drpc.org

if [[ -z "$NETWORK" ]]; then
    echo "Must set NETWORK env variable" 1>&2
    exit 1
fi

NETWORK_STATE_FILE="deployed-${NETWORK}.json"
if [ ! -f $NETWORK_STATE_FILE ]; then
    echo "Cannot find network state file ${NETWORK_STATE_FILE}"
    exit 1
fi
echo "Using network state file ${NETWORK_STATE_FILE}"

function jsonGet {
    node -e "const fs = require('fs'); const obj = JSON.parse(fs.readFileSync('${NETWORK_STATE_FILE}', 'utf8')); const path='$1'; let res = path.split('.').reduce(function(o, k) {return o && o[k] }, obj);  console.log(res)"
}

function verify {
    contractPath="$(jsonGet ${1}.contract)"
    contractName="${contractPath##*/}"
    contractName="${contractName%.*}"
    argsJson=$(jsonGet ${1}.constructorArgs)
    echo "module.exports = $argsJson" > contract-args.js
    npx hardhat --network $NETWORK verify --contract "$contractPath:$contractName" --constructor-args contract-args.js $(jsonGet ${1}.address)
}

# NB: Although most of the contracts listed below would be verified by running
# this bash script as it is, some might require some manual tweaking.
# Sometimes first attempt to verify fails without observable reason.
# Part of the contract require a workaround see SCRATCH_DEPLOY.md section
# "Issues with verification of part of the contracts deployed from factories".

verify dummyEmptyContract
verify burner
verify hashConsensusForAccountingOracle
verify hashConsensusForValidatorsExitBusOracle
verify accountingOracle.implementation
verify accountingOracle.proxy
verify validatorsExitBusOracle.implementation
verify validatorsExitBusOracle.proxy
verify triggerableExitMock
verify stakingRouter.implementation
verify stakingRouter.proxy
verify withdrawalQueueERC721.proxy
verify wstETH
verify executionLayerRewardsVault
verify eip712StETH
verify lidoTemplate
verify withdrawalVault.proxy
verify withdrawalVault.implementation
verify lidoLocator.proxy
verify lidoLocator.implementation
verify app:lido.implementation
verify app:oracle.implementation
verify app:node-operators-registry.implementation
verify app:aragon-voting.implementation
verify app:aragon-token-manager.implementation
verify app:aragon-finance.implementation
verify app:aragon-agent.implementation
verify oracleDaemonConfig
verify oracleReportSanityChecker
verify app:lido.proxy
verify depositSecurityModule
verify withdrawalQueueERC721.implementation
verify aragon-kernel.implementation
verify aragon-acl.implementation
verify aragon-kernel.proxy
verify ldo
verify callsScript
verify aragon-evm-script-registry.proxy
verify aragon-apm-registry.implementation
verify aragon-apm-registry.factory
verify aragon-app-repo-lido.implementation
verify aragon-app-repo-node-operators-registry.implementation
# NB: App Repos of lido, oracle, node-operators-registry, finance, agent, token-manager, voting
#     share same implementation of Repo contract
verify aragon-evm-script-registry.proxy
verify aragon-evm-script-registry.implementation
verify app:simple-dvt.proxy
verify app:aragon-token-manager.proxy
verify app:oracle.proxy
verify app:node-operators-registry.proxy
verify app:aragon-voting.proxy
verify app:aragon-finance.proxy
verify app:aragon-agent.proxy
