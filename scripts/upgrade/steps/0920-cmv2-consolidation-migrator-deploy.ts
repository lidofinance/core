import { ethers } from "hardhat";
import { checkArtifactDeployedAndLog } from "scripts/utils/upgrade";

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
  loadContract,
  log,
  logArgs,
  logConfirmReview,
  logScriptHeader,
  logStartReview,
  readNetworkState,
  Sk,
} from "lib";
import { DeploymentState } from "lib/state-file";

/**
 * Inputs of the ConsolidationMigrator instance that consolidates keys inside Curated Module v2.
 * Source and target module are the same module, so a pair moves stake between validators of
 * the CMv2 operators it names.
 */
interface CMv2ConsolidationMigratorConfig {
  agent: string;
  stakingRouter: string;
  consolidationBus: string;
  cmv2ModuleId: bigint;
}

export async function skip(): Promise<boolean> {
  return await checkArtifactDeployedAndLog(Sk.consolidationMigratorCMv2);
}

/**
 * Deploys a ConsolidationMigrator with Curated Module v2 as both the source and the target module.
 *
 * The proxy admin and the single DEFAULT_ADMIN_ROLE holder is the Aragon Agent. The deployer holds
 * no role at any point. Pair roles and the ConsolidationBus PUBLISH_ROLE are granted by a DAO vote.
 */
export async function main() {
  const deployer = (await getDeployerSigner()).address;

  await logScriptHeader("CMv2 internal consolidation — Deploy ConsolidationMigrator (CMv2 -> CMv2)", deployer);

  const config = await resolveConfig(readNetworkState());
  // Module ids are numbers because the state file stores constructor arguments as JSON
  const moduleId = Number(config.cmv2ModuleId);
  const constructorArgs = [config.stakingRouter, config.consolidationBus, moduleId, moduleId];
  // The proxy constructor runs `initialize(agent)`, so the Agent is the only admin from the first block
  const initData = ConsolidationMigrator__factory.createInterface().encodeFunctionData("initialize", [config.agent]);

  logStartReview();
  await logArgs("ConsolidationMigrator", constructorArgs);
  log.info("OssifiableProxy for ConsolidationMigrator", {
    "admin (Agent)": config.agent,
    "initialize admin (Agent)": config.agent,
    "initialization data": initData,
  });
  await logConfirmReview();

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

  await assertCMv2ConsolidationMigratorDeployState(readNetworkState());
}

/**
 * Check the deployed instance before the DAO vote: immutables, proxy admin, initialization,
 * and an empty role set except the Agent as the single DEFAULT_ADMIN_ROLE holder.
 */
export async function assertCMv2ConsolidationMigratorDeployState(state: DeploymentState) {
  const config = await resolveConfig(state);
  const entry = state[Sk.consolidationMigratorCMv2];
  const proxyAddress: string = entry.proxy.address;
  const implementationAddress: string = entry.implementation.address;

  const proxy = await loadContract<OssifiableProxy>("OssifiableProxy", proxyAddress);
  const migrator = await loadContract<ConsolidationMigrator>("ConsolidationMigrator", proxyAddress);
  const implementation = await loadContract<ConsolidationMigrator>("ConsolidationMigrator", implementationAddress);

  const checks: [string, boolean][] = [];
  const check = (name: string, ok: boolean) => checks.push([name, ok]);

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

  const DEFAULT_ADMIN_ROLE = await migrator.DEFAULT_ADMIN_ROLE();
  check("DEFAULT_ADMIN_ROLE has one holder", (await migrator.getRoleMemberCount(DEFAULT_ADMIN_ROLE)) === 1n);
  check("DEFAULT_ADMIN_ROLE holder is Agent", await migrator.hasRole(DEFAULT_ADMIN_ROLE, config.agent));
  check("ALLOW_PAIR_ROLE has no holder", (await migrator.getRoleMemberCount(await migrator.ALLOW_PAIR_ROLE())) === 0n);
  check(
    "DISALLOW_PAIR_ROLE has no holder",
    (await migrator.getRoleMemberCount(await migrator.DISALLOW_PAIR_ROLE())) === 0n,
  );

  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  log.info("CMv2 ConsolidationMigrator deploy state", Object.fromEntries(checks.map(([n, ok]) => [n, ok])));
  if (failed.length > 0) {
    throw new Error(`CMv2 ConsolidationMigrator deploy state check failed: ${failed.join("; ")}`);
  }
}

/**
 * Resolve the deploy inputs from the state file and the chain.
 *
 * The CMv2 module id is the target module of the existing CMv1 -> CMv2 migrator. It must
 * resolve in the StakingRouter to the CMv2 proxy recorded in the state file, and the existing
 * migrator must point to the same router and bus.
 */
async function resolveConfig(state: DeploymentState): Promise<CMv2ConsolidationMigratorConfig> {
  const agent = getAddress(Sk.appAgent, state);
  const consolidationBus = getAddress(Sk.consolidationBus, state);
  const cmv2Address = getAddress(Sk.sm_CM, state);

  const locator = await loadContract<LidoLocator>("LidoLocator", getAddress(Sk.lidoLocator, state));
  const stakingRouter = await locator.stakingRouter();

  const existingMigrator = await loadContract<ConsolidationMigrator>(
    "ConsolidationMigrator",
    getAddress(Sk.consolidationMigrator, state),
  );
  const cmv2ModuleId = await existingMigrator.targetModuleId();

  if (!sameAddress(await existingMigrator.getStakingRouter(), stakingRouter)) {
    throw new Error("Existing ConsolidationMigrator uses another StakingRouter than the locator");
  }
  if (!sameAddress(await existingMigrator.getConsolidationBus(), consolidationBus)) {
    throw new Error("Existing ConsolidationMigrator uses another ConsolidationBus than the state file");
  }

  const router = await loadContract<StakingRouter>("StakingRouter", stakingRouter);
  const module = await router.getStakingModule(cmv2ModuleId);
  if (!sameAddress(module.stakingModuleAddress, cmv2Address)) {
    throw new Error(
      `StakingRouter module ${cmv2ModuleId} is ${module.stakingModuleAddress}, expected CMv2 ${cmv2Address}`,
    );
  }

  return { agent, stakingRouter, consolidationBus, cmv2ModuleId };
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
