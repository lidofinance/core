import { ethers, network } from "hardhat";

import {
  ConsolidationMigrator,
  ConsolidationMigrator__factory,
  LidoLocator,
  OssifiableProxy,
  StakingRouter,
} from "typechain-types";

import {
  deployBehindOssifiableProxy,
  getAddress,
  getDeployerSigner,
  isContractDeployed,
  loadContract,
  log,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  makeTx,
  readNetworkState,
  Sk,
  toBool,
} from "lib";
import { DeploymentState, getAddressValidated } from "lib/state-file";

// Networks where the operator must confirm the review prompt by hand
const LIVE_NETWORKS = ["mainnet", "hoodi", "sepolia"];

/**
 * Inputs of the ConsolidationMigrator instance that consolidates keys inside Curated Module v2.
 * Source and target module are the same module, so a pair moves stake between validators of
 * the CMv2 operators it names.
 */
interface CMv2ConsolidationMigratorConfig {
  agent: string;
  committee: string;
  locator: string;
  stakingRouter: string;
  consolidationBus: string;
  existingMigrator: string;
  cmv2ModuleId: bigint;
  cmv2Module: string;
  cmv2ModuleName: string;
}

/**
 * The step is done when the proxy is deployed and its final pre-vote state holds. A deployed proxy
 * with an unfinished role setup is not skipped: `main` finishes the setup without a new deploy.
 */
export async function skip(): Promise<boolean> {
  const state = readNetworkState();
  const address = getAddressValidated(Sk.consolidationMigratorCMv2, state);
  if (!address || !(await isContractDeployed(address))) return false;

  const failed = (await checkDeployState(state)).filter(([, ok]) => !ok);
  if (failed.length === 0) {
    log(`CMv2 ConsolidationMigrator is deployed at ${address} and its role setup is complete, skipping...`);
  }
  return failed.length === 0;
}

/**
 * Deploys a ConsolidationMigrator with Curated Module v2 as both the source and the target module.
 *
 * Transactions from the deployer:
 * 1. ConsolidationMigrator implementation.
 * 2. OssifiableProxy with the Agent as proxy admin; its constructor runs `initialize(deployer)`.
 * 3. grantRole(ALLOW_PAIR_ROLE, CMC).
 * 4. grantRole(DISALLOW_PAIR_ROLE, CMC).
 * 5. grantRole(DEFAULT_ADMIN_ROLE, Agent).
 * 6. renounceRole(DEFAULT_ADMIN_ROLE, deployer).
 *
 * After transaction 6 the deployer holds no role. The DAO vote grants the ConsolidationBus PUBLISH_ROLE.
 * A rerun after a failure skips the deploy when the proxy exists and sends only the missing role calls.
 */
export async function main() {
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("CMv2 internal consolidation — Deploy ConsolidationMigrator (CMv2 -> CMv2)", deployer);

  if (LIVE_NETWORKS.includes(network.name) && toBool(process.env.AUTO_CONFIRM)) {
    throw new Error(`AUTO_CONFIRM must be off on ${network.name}: the operator confirms the review by hand`);
  }

  const state = readNetworkState();
  const config = await resolveConfig(state);
  // Module ids are numbers because the state file stores constructor arguments as JSON
  const moduleId = Number(config.cmv2ModuleId);
  const constructorArgs = [config.stakingRouter, config.consolidationBus, moduleId, moduleId];
  // The deployer is the temporary admin: it grants the pair roles and hands the admin role to the Agent
  const initData = ConsolidationMigrator__factory.createInterface().encodeFunctionData("initialize", [deployer]);

  const existingProxy = getAddressValidated(Sk.consolidationMigratorCMv2, state);
  const resume = !!existingProxy && (await isContractDeployed(existingProxy));

  // A fresh deploy sends the implementation and the proxy first, in this order
  const { chainId } = await ethers.provider.getNetwork();
  const nonce = await ethers.provider.getTransactionCount(deployer, "pending");
  const expectedImplementation = ethers.getCreateAddress({ from: deployer, nonce });
  const expectedProxy = ethers.getCreateAddress({ from: deployer, nonce: nonce + 1 });

  logStartReview();
  log.info("Deployment", {
    "network": network.name,
    "chain ID": chainId,
    "deployer": deployer,
    "deployer nonce": nonce,
  });
  log.info("Inputs and their sources", {
    "Agent": `${config.agent} (state file ${Sk.appAgent})`,
    "CMC": `${config.committee} (the only DISALLOW_PAIR_ROLE holder on the CMv1 -> CMv2 migrator)`,
    "StakingRouter": `${config.stakingRouter} (LidoLocator ${config.locator} stakingRouter())`,
    "ConsolidationBus": `${config.consolidationBus} (state file ${Sk.consolidationBus})`,
    "CMv2 module id": `${config.cmv2ModuleId} (targetModuleId() of the CMv1 -> CMv2 migrator ${config.existingMigrator})`,
    "CMv2 module": `${config.cmv2Module} "${config.cmv2ModuleName}" (StakingRouter module ${config.cmv2ModuleId} = state file ${Sk.sm_CM})`,
  });
  if (resume) {
    log.info("Resume", {
      "existing proxy": existingProxy!,
      "plan": "no deploy; send only the missing calls of tx 3-6",
    });
  } else {
    await logArgs("ConsolidationMigrator", constructorArgs, "constructor", `implementation, tx 1 of 6, nonce ${nonce}`);
    await logArgs(
      "OssifiableProxy",
      [expectedImplementation, config.agent, initData],
      "constructor",
      `proxy, tx 2 of 6, nonce ${nonce + 1}`,
    );
    log.info("Proxy initialization data", {
      decoded: `initialize(${deployer}) — the deployer, temporary admin until tx 6`,
    });
  }
  log.info("Role setup on the proxy", {
    "tx 3": `grantRole(ALLOW_PAIR_ROLE, ${config.committee}) — CMC`,
    "tx 4": `grantRole(DISALLOW_PAIR_ROLE, ${config.committee}) — CMC`,
    "tx 5": `grantRole(DEFAULT_ADMIN_ROLE, ${config.agent}) — Agent`,
    "tx 6": `renounceRole(DEFAULT_ADMIN_ROLE, ${deployer}) — deployer`,
  });
  if (!resume) {
    log.info("Expected addresses", {
      "ConsolidationMigrator implementation": expectedImplementation,
      "OssifiableProxy (the new ConsolidationMigrator)": expectedProxy,
    });
  }
  await logConfirmReview();

  if (!resume) {
    await deployBehindOssifiableProxy(
      Sk.consolidationMigratorCMv2,
      "ConsolidationMigrator",
      config.agent,
      deployer,
      constructorArgs,
      null, // implementation
      true, // withStateFile
      undefined, // factoryOptions
      initData,
    );

    const entry = readNetworkState()[Sk.consolidationMigratorCMv2];
    if (
      !sameAddress(entry.implementation.address, expectedImplementation) ||
      !sameAddress(entry.proxy.address, expectedProxy)
    ) {
      throw new Error(
        `Deployed addresses differ from the reviewed ones: implementation ${entry.implementation.address}, ` +
          `proxy ${entry.proxy.address}`,
      );
    }
  }

  const migrator = await loadContract<ConsolidationMigrator>(
    "ConsolidationMigrator",
    getAddress(Sk.consolidationMigratorCMv2, readNetworkState()),
  );
  const DEFAULT_ADMIN_ROLE = await migrator.DEFAULT_ADMIN_ROLE();
  const grants: [string, string, string][] = [
    ["ALLOW_PAIR_ROLE", await migrator.ALLOW_PAIR_ROLE(), config.committee],
    ["DISALLOW_PAIR_ROLE", await migrator.DISALLOW_PAIR_ROLE(), config.committee],
    ["DEFAULT_ADMIN_ROLE", DEFAULT_ADMIN_ROLE, config.agent],
  ];
  for (const [name, role, account] of grants) {
    if (await migrator.hasRole(role, account)) {
      log(`${name} is already granted to ${account}`);
      continue;
    }
    await makeTx(migrator, "grantRole", [role, account], { from: deployer });
  }
  if (await migrator.hasRole(DEFAULT_ADMIN_ROLE, deployer)) {
    await makeTx(migrator, "renounceRole", [DEFAULT_ADMIN_ROLE, deployer], { from: deployer });
  }

  await assertCMv2ConsolidationMigratorDeployState(readNetworkState());
}

/**
 * Check the deployed instance before the DAO vote: immutables, proxy admin, initialization, the Agent
 * as the only DEFAULT_ADMIN_ROLE holder and the CMC as the only pair-role holder.
 */
export async function assertCMv2ConsolidationMigratorDeployState(state: DeploymentState) {
  const checks = await checkDeployState(state);
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log.info("CMv2 ConsolidationMigrator deploy state", Object.fromEntries(checks));
  if (failed.length > 0) {
    throw new Error(`CMv2 ConsolidationMigrator deploy state check failed: ${failed.join("; ")}`);
  }
}

async function checkDeployState(state: DeploymentState): Promise<[string, boolean][]> {
  const config = await resolveConfig(state);
  const entry = state[Sk.consolidationMigratorCMv2];
  const proxyAddress: string = entry.proxy.address;
  const implementationAddress: string = entry.implementation.address;

  const proxy = await loadContract<OssifiableProxy>("OssifiableProxy", proxyAddress);
  const migrator = await loadContract<ConsolidationMigrator>("ConsolidationMigrator", proxyAddress);
  const implementation = await loadContract<ConsolidationMigrator>("ConsolidationMigrator", implementationAddress);

  const checks: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => checks.push([name, ok]);
  const onlyHolder = async (role: string, account: string) => {
    const members = await migrator.getRoleMembers(role);
    return members.length === 1 && sameAddress(members[0], account);
  };

  check("proxy admin is Agent", sameAddress(await proxy.proxy__getAdmin(), config.agent));
  check("proxy implementation", sameAddress(await proxy.proxy__getImplementation(), implementationAddress));
  check("proxy is not ossified", !(await proxy.proxy__getIsOssified()));

  for (const contract of [migrator, implementation]) {
    const label = contract === migrator ? "proxy" : "implementation";
    check(`${label} sourceModuleId is CMv2`, (await contract.sourceModuleId()) === config.cmv2ModuleId);
    check(`${label} targetModuleId is CMv2`, (await contract.targetModuleId()) === config.cmv2ModuleId);
    check(`${label} StakingRouter`, sameAddress(await contract.getStakingRouter(), config.stakingRouter));
    check(`${label} ConsolidationBus`, sameAddress(await contract.getConsolidationBus(), config.consolidationBus));
    check(`${label} cannot be initialized again`, await reverts(() => contract.initialize.staticCall(config.agent)));
  }

  check("DEFAULT_ADMIN_ROLE: only the Agent", await onlyHolder(await migrator.DEFAULT_ADMIN_ROLE(), config.agent));
  check("ALLOW_PAIR_ROLE: only the CMC", await onlyHolder(await migrator.ALLOW_PAIR_ROLE(), config.committee));
  check("DISALLOW_PAIR_ROLE: only the CMC", await onlyHolder(await migrator.DISALLOW_PAIR_ROLE(), config.committee));

  return checks;
}

/**
 * Resolve the deploy inputs from the state file and the chain.
 *
 * The CMv2 module id is the target module of the existing CMv1 -> CMv2 migrator. It must
 * resolve in the StakingRouter to the CMv2 proxy recorded in the state file, and the existing
 * migrator must point to the same router and bus. The CMC is the only DISALLOW_PAIR_ROLE
 * holder on the existing migrator.
 */
async function resolveConfig(state: DeploymentState): Promise<CMv2ConsolidationMigratorConfig> {
  const agent = getAddress(Sk.appAgent, state);
  const consolidationBus = getAddress(Sk.consolidationBus, state);
  const cmv2Address = getAddress(Sk.sm_CM, state);
  const locatorAddress = getAddress(Sk.lidoLocator, state);
  const existingMigratorAddress = getAddress(Sk.consolidationMigrator, state);

  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const stakingRouter = await locator.stakingRouter();

  const existingMigrator = await loadContract<ConsolidationMigrator>("ConsolidationMigrator", existingMigratorAddress);
  const cmv2ModuleId = await existingMigrator.targetModuleId();

  if (!sameAddress(await existingMigrator.getStakingRouter(), stakingRouter)) {
    throw new Error("Existing ConsolidationMigrator uses another StakingRouter than the locator");
  }
  if (!sameAddress(await existingMigrator.getConsolidationBus(), consolidationBus)) {
    throw new Error("Existing ConsolidationMigrator uses another ConsolidationBus than the state file");
  }

  const committees = await existingMigrator.getRoleMembers(await existingMigrator.DISALLOW_PAIR_ROLE());
  if (committees.length !== 1) {
    throw new Error(`Expected one DISALLOW_PAIR_ROLE holder on the existing migrator, got ${committees.length}`);
  }

  const router = await loadContract<StakingRouter>("StakingRouter", stakingRouter);
  const module = await router.getStakingModule(cmv2ModuleId);
  if (!sameAddress(module.stakingModuleAddress, cmv2Address)) {
    throw new Error(
      `StakingRouter module ${cmv2ModuleId} is ${module.stakingModuleAddress}, expected CMv2 ${cmv2Address}`,
    );
  }

  return {
    agent,
    committee: committees[0],
    locator: locatorAddress,
    stakingRouter,
    consolidationBus,
    existingMigrator: existingMigratorAddress,
    cmv2ModuleId,
    cmv2Module: module.stakingModuleAddress,
    cmv2ModuleName: module.name,
  };
}

function sameAddress(a: string, b: string) {
  return ethers.getAddress(a) === ethers.getAddress(b);
}

async function reverts(call: () => Promise<unknown>) {
  try {
    await call();
    return false;
  } catch {
    return true;
  }
}
