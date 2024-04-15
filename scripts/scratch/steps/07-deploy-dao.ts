import { assert } from "chai";
import chalk from "chalk";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import {
  ERCProxy__factory,
  EVMScriptRegistryFactory,
  EVMScriptRegistryFactory__factory,
  Kernel__factory,
} from "typechain-types";

import { getContractAt, getContractPath, loadContract, LoadedContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { findEvents, findEventsWithAbi } from "lib/event";
import { log } from "lib/log";
import {
  AppNames,
  DeploymentState,
  persistNetworkState,
  readNetworkState,
  setValueInState,
  Sk,
  updateObjectInState,
} from "lib/state-file";

// See KernelConstants.sol
const KERNEL_DEFAULT_ACL_APP_ID = "0xe3262375f45a6e2026b7e7b18c2b807434f2508fe1a2a3dfb493c7df8f4aad6a";

async function main() {
  log.scriptStart(__filename);
  const deployer = (await ethers.provider.getSigner()).address;
  let state = readNetworkState({ deployer });

  const template = await getContractAt("LidoTemplate", state[Sk.lidoTemplate].address);
  if (state[Sk.lidoTemplate].deployBlock) {
    log(`Using LidoTemplate deploy block: ${chalk.yellow(state.lidoTemplate.deployBlock)}`);
  }

  const newDAOReceipt = await doTemplateNewDAO(template, deployer, state[Sk.daoInitialSettings]);
  state = setValueInState(Sk.lidoTemplateNewDaoTx, newDAOReceipt.hash);

  await saveStateFromNewDAOTx(newDAOReceipt);

  log.scriptFinish(__filename);
}

async function doTemplateNewDAO(
  template: LoadedContract,
  deployer: string,
  daoInitialSettings: DeploymentState,
): Promise<ContractTransactionReceipt> {
  const votingSettings = [
    daoInitialSettings.voting.minSupportRequired,
    daoInitialSettings.voting.minAcceptanceQuorum,
    daoInitialSettings.voting.voteDuration,
    daoInitialSettings.voting.objectionPhaseDuration,
  ];

  log(`Using DAO token settings:`, daoInitialSettings.token);
  log(`Using DAO voting settings:`, daoInitialSettings.voting);
  const receipt = await makeTx(
    template,
    "newDAO",
    [daoInitialSettings.token.name, daoInitialSettings.token.symbol, votingSettings],
    { from: deployer },
  );
  return receipt;
}

function updateAgentVestingAddressPlaceholder(state: DeploymentState) {
  const AGENT_VESTING_PLACEHOLDER = "lido-aragon-agent-placeholder";
  if (state[Sk.appAgent]) {
    const agentAddress = state[Sk.appAgent].proxy.address;
    const vestingAmount = state[Sk.vestingParams].holders[AGENT_VESTING_PLACEHOLDER];
    state[Sk.vestingParams].holders[agentAddress] = vestingAmount;
    delete state[Sk.vestingParams].holders[AGENT_VESTING_PLACEHOLDER];
  } else {
    throw new Error(
      `Failed to update ${AGENT_VESTING_PLACEHOLDER} placeholder: there is no Agent contract entry ${Sk.appAgent}`,
    );
  }
}

async function saveStateFromNewDAOTx(newDAOReceipt: ContractTransactionReceipt) {
  let state = readNetworkState();

  const newDAOEvent = findEvents(newDAOReceipt, "TmplDAOAndTokenDeployed")[0];

  const kernelProxyAddress = newDAOEvent.args.dao;
  state = updateObjectInState(Sk.aragonKernel, {
    proxy: {
      address: kernelProxyAddress,
      contract: await getContractPath("KernelProxy"),
      constructorArgs: [
        // see DAOFactory.newDAO
        state[Sk.aragonKernel].implementation.address,
      ],
    },
  });

  const daoTokenAddress = newDAOEvent.args.token;
  state = updateObjectInState(Sk.ldo, {
    address: daoTokenAddress,
    contract: await getContractPath("MiniMeToken"),
    constructorArgs: [
      // see LidoTemplate._createToken
      state[Sk.miniMeTokenFactory].address,
      ethers.ZeroAddress,
      0,
      state[Sk.daoInitialSettings].token.name,
      18, // see LidoTemplate.TOKEN_DECIMALS
      state[Sk.daoInitialSettings].token.symbol,
      true,
    ],
  });

  const evmScriptRegistryFactory = await loadContract<EVMScriptRegistryFactory>(
    EVMScriptRegistryFactory__factory,
    state[Sk.evmScriptRegistryFactory].address,
  );
  state = updateObjectInState(Sk.callsScript, {
    address: await evmScriptRegistryFactory.baseCallScript(),
    contract: await getContractPath("CallsScript"),
    constructorArgs: [], // see EVMScriptRegistryFactory.baseCallScript
  });

  const appInstalledEvents = findEvents(newDAOReceipt, "TmplAppInstalled");
  const lidoApmEnsName = state[Sk.lidoApmEnsName];

  const VALID_APP_NAMES = Object.entries(AppNames).map((e) => e[1]);
  const appIdNameEntries = VALID_APP_NAMES.map((name) => [ethers.namehash(`${name}.${lidoApmEnsName}`), name]);
  const appNameByAppId = Object.fromEntries(appIdNameEntries);
  const expectedAppIds = appIdNameEntries.map((e) => e[0]);

  const idsCheckDesc = `all (and only) expected apps are installed`;
  assert.sameMembers(
    appInstalledEvents.map((evt) => evt.args.appId),
    expectedAppIds,
    idsCheckDesc,
  );
  log.success(idsCheckDesc);

  const kernel = await Kernel__factory.connect(kernelProxyAddress, ethers.provider);
  const APP_BASES_NAMESPACE = await kernel.APP_BASES_NAMESPACE();

  const dataByAppName: { [key: string]: { [key: string]: string } } = {};
  for (const evt of appInstalledEvents) {
    const appId = evt.args.appId;
    const appName = appNameByAppId[appId];

    const proxyAddress = ethers.getAddress(evt.args.appProxy);

    const proxy = await ERCProxy__factory.connect(proxyAddress, ethers.provider);
    const implAddress = await proxy.implementation();

    const kernelBaseAddr = await kernel.getApp(APP_BASES_NAMESPACE, appId);

    const baseCheckDesc = `${appName}: the installed app base is ${chalk.yellow(implAddress)}`;
    assert.equal(ethers.getAddress(kernelBaseAddr), ethers.getAddress(implAddress), baseCheckDesc);
    log.success(baseCheckDesc);

    dataByAppName[appName] = {
      name: appName,
      fullName: `${appName}.${lidoApmEnsName}`,
      id: appId,
      proxyAddress,
      initializeData: evt.args.initializeData || "0x",
    };
  }

  state = readNetworkState();
  for (const [appName, appData] of Object.entries(dataByAppName)) {
    const key = `app:${appName}`;
    const proxyAddress = appData.proxyAddress;
    const initializeData = appData.initializeData;
    delete appData.proxyAddress;
    delete appData.initializeData;
    state[key] = {
      ...state[key],
      aragonApp: appData,
      proxy: {
        address: proxyAddress,
        contract: await getContractPath("AppProxyUpgradeable"),
        constructorArgs: [
          // see AppProxyFactory
          kernelProxyAddress,
          appData.id,
          initializeData,
        ],
      },
    };
  }
  updateAgentVestingAddressPlaceholder(state);
  persistNetworkState(state);

  // Get missing proxies
  const newAppProxyEvents = findEventsWithAbi(newDAOReceipt, "NewAppProxy", Kernel__factory.abi);
  for (const e of newAppProxyEvents) {
    const appId = e.args.appId;
    if (appNameByAppId[appId] !== undefined) continue;

    let proxyContractName, appName;

    if (appId == KERNEL_DEFAULT_ACL_APP_ID) {
      proxyContractName = "AppProxyUpgradeable";
      appName = Sk.aragonAcl;
    } else {
      // otherwise it is EvmScriptRegistry
      proxyContractName = "AppProxyPinned";
      appName = Sk.aragonEvmScriptRegistry;
    }

    const proxy = await getContractAt(proxyContractName, e.args.proxy);

    state[appName] = {
      ...state[appName],
      proxy: {
        address: proxy.address,
        constructorArgs: [
          // See Kernel.initialize
          kernelProxyAddress,
          appId,
          "0x00",
        ],
        contract: await getContractPath(proxyContractName),
      },
      aragonApp: {
        name: appName,
        id: appId,
      },
    };
    if (appName === Sk.aragonEvmScriptRegistry) {
      state[appName].implementation = {
        address: await proxy.getFunction("implementation")(),
        contract: await getContractPath("EVMScriptRegistry"),
        constructorArgs: [], // see DAOFactory.newDAO and EVMScriptRegistryFactory.baseReg
      };
    }
  }
  persistNetworkState(state);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
