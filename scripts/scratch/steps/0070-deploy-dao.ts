import { assert } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { ERCProxy, EVMScriptRegistryFactory, Kernel } from "typechain-types";

import { getContractAt, getContractPath, loadContract, LoadedContract } from "lib/contract";
import { makeTx } from "lib/deploy";
import { findEvents, findEventsWithInterfaces } from "lib/event";
import { cy, log, yl } from "lib/log";
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
  log.emptyLine();

  // Create a new DAO using the template
  return await makeTx(
    template,
    "newDAO",
    [daoInitialSettings.token.name, daoInitialSettings.token.symbol, votingSettings],
    { from: deployer },
  );
}

function updateAgentVestingAddressPlaceholder(state: DeploymentState) {
  const AGENT_VESTING_PLACEHOLDER = "lido-aragon-agent-placeholder";
  if (state[Sk.appAgent]) {
    // Replace placeholder with actual agent address
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

  // Extract DAO and token addresses from the event
  const newDAOEvent = findEvents(newDAOReceipt, "TmplDAOAndTokenDeployed")[0];
  const kernelProxyAddress = newDAOEvent.args.dao;
  const daoTokenAddress = newDAOEvent.args.token;

  // Update state with kernel proxy information
  state = updateObjectInState(Sk.aragonKernel, {
    proxy: {
      address: kernelProxyAddress,
      contract: await getContractPath("KernelProxy"),
      // see DAOFactory.newDAO
      constructorArgs: [state[Sk.aragonKernel].implementation.address],
    },
  });

  // Update state with DAO token information
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

  // Load EVM script registry factory and update state
  const evmScriptRegistryFactory = await loadContract<EVMScriptRegistryFactory>(
    "EVMScriptRegistryFactory",
    state[Sk.evmScriptRegistryFactory].address,
  );

  state = updateObjectInState(Sk.callsScript, {
    address: await evmScriptRegistryFactory.baseCallScript(),
    contract: await getContractPath("CallsScript"),
    constructorArgs: [],
  });

  // Process installed apps
  const appInstalledEvents = findEvents(newDAOReceipt, "TmplAppInstalled");
  const lidoApmEnsName = state[Sk.lidoApmEnsName];

  const VALID_APP_NAMES = Object.entries(AppNames).map((e) => e[1]);
  const appIdNameEntries = VALID_APP_NAMES.map((name) => [ethers.namehash(`${name}.${lidoApmEnsName}`), name]);
  const appNameByAppId = Object.fromEntries(appIdNameEntries);
  const expectedAppIds = appIdNameEntries.map((e) => e[0]);

  // Verify all expected apps are installed
  const idsCheckDesc = `all (and only) expected apps are installed`;
  assert.sameMembers(
    appInstalledEvents.map((evt) => evt.args.appId),
    expectedAppIds,
    idsCheckDesc,
  );
  log.success(idsCheckDesc);

  const kernel = await loadContract<Kernel>("Kernel", kernelProxyAddress);
  const APP_BASES_NAMESPACE = await kernel.APP_BASES_NAMESPACE();

  // Process each installed app
  const dataByAppName: { [key: string]: { [key: string]: string } } = {};
  for (const evt of appInstalledEvents) {
    const appId = evt.args.appId;
    const appName = appNameByAppId[appId];
    const proxyAddress = ethers.getAddress(evt.args.appProxy);

    const proxy = await loadContract<ERCProxy>("ERCProxy", proxyAddress);
    const implAddress = await proxy.implementation();

    const kernelBaseAddr = await kernel.getApp(APP_BASES_NAMESPACE, appId);

    // Verify app base
    const baseCheckDesc = `${appName}: the installed app base is ${cy(implAddress)}`;
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

  // Update state with app information
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
        // see AppProxyFactory
        constructorArgs: [kernelProxyAddress, appData.id, initializeData],
      },
    };
  }
  updateAgentVestingAddressPlaceholder(state);
  persistNetworkState(state);

  // Process missing proxies (ACL and EVMScriptRegistry)
  const newAppProxyEvents = findEventsWithInterfaces(newDAOReceipt, "NewAppProxy", [kernel.interface]);
  for (const e of newAppProxyEvents) {
    const appId = e.args.appId;
    if (appNameByAppId[appId] !== undefined) continue;

    let proxyContractName, appName;

    if (appId == KERNEL_DEFAULT_ACL_APP_ID) {
      proxyContractName = "AppProxyUpgradeable";
      appName = Sk.aragonAcl;
    } else {
      proxyContractName = "AppProxyPinned";
      appName = Sk.aragonEvmScriptRegistry;
    }

    const proxy = await getContractAt(proxyContractName, e.args.proxy);

    state[appName] = {
      ...state[appName],
      proxy: {
        address: proxy.address,
        // See Kernel.initialize
        constructorArgs: [kernelProxyAddress, appId, "0x00"],
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

  log.emptyLine(); // Make the output more readable

  persistNetworkState(state);
}

export async function main() {
  const deployer = (await ethers.provider.getSigner()).address;
  const state = readNetworkState({ deployer });

  const template = await getContractAt("LidoTemplate", state[Sk.lidoTemplate].address);
  if (state[Sk.lidoTemplate].deployBlock) {
    log(`Using LidoTemplate deploy block: ${yl(state.lidoTemplate.deployBlock)}`);
  }

  const newDAOReceipt = await doTemplateNewDAO(template, deployer, state[Sk.daoInitialSettings]);

  setValueInState(Sk.lidoTemplateNewDaoTx, newDAOReceipt.hash);

  await saveStateFromNewDAOTx(newDAOReceipt);
}
