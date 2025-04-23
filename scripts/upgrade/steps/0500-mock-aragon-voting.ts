import { ethers } from "hardhat";

import { mine } from "@nomicfoundation/hardhat-network-helpers";

import {
  Burner,
  ICSModule,
  Kernel,
  LidoLocator,
  OssifiableProxy,
  Repo,
  StakingRouter,
  UpgradeTemplateV3,
} from "typechain-types";

import { ether, log } from "lib";
import { impersonate } from "lib/account";
import { loadContract } from "lib/contract";
import { DeploymentState, readNetworkState, Sk } from "lib/state-file";

import { readUpgradeParameters } from "../upgrade-utils";

const CS_STAKING_MODULE_ID = 3;
const TX_GAS_LIMIT = 1_000_000;

async function getCSAccountingAddress(state: DeploymentState) {
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  const csStakingModuleAddress = (await stakingRouter.getStakingModule(CS_STAKING_MODULE_ID)).stakingModuleAddress;
  const csStakingModule = await loadContract<ICSModule>("ICSModule", csStakingModuleAddress);
  return await csStakingModule.accounting();
}

export async function main(): Promise<void> {
  const state = readNetworkState();
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const votingAddress = state[Sk.appVoting].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;
  const locatorImplAddress = state[Sk.lidoLocator].implementation.address;
  const lidoImplAddress = state[Sk.appLido].implementation.address;
  const accountingOracleImplAddress = state[Sk.accountingOracle].implementation.address;
  const kernelAddress = state[Sk.aragonKernel].proxy.address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const upgradeTemplateV3Address = state[Sk.upgradeTemplateV3].address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;
  const simpleDvtAddress = state[Sk.appSimpleDvt].proxy.address;
  const aragonLidoAppRepoAddress = state[Sk.aragonLidoAppRepo].proxy.address;

  // Disable automine to ensure all transactions happen in the same block
  // Also need to specify gasLimit for transactions according to
  // https://hardhat.org/hardhat-network/docs/explanation/mining-modes#mining-multiple-transactions-in-one-block
  // so multiple transactions can fit into one block
  await ethers.provider.send("evm_setAutomine", [false]);

  // while locator is not upgraded yet we can fetch the old burner address
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const oldBurnerAddress = await locator.burner();

  const parameters = readUpgradeParameters();
  const lidoAppNewVersion = parameters[Sk.appLido].newVersion;

  const agentSigner = await impersonate(agentAddress, ether("1"));
  const votingSigner = await impersonate(votingAddress, ether("1"));

  const locatorProxy = await loadContract<OssifiableProxy>("OssifiableProxy", locatorAddress);
  await locatorProxy.connect(agentSigner).proxy__upgradeTo(locatorImplAddress, { gasLimit: TX_GAS_LIMIT });
  log("LidoLocator upgraded to implementation", locatorImplAddress);

  const upgradeTemplate = await loadContract<UpgradeTemplateV3>("UpgradeTemplateV3", upgradeTemplateV3Address);
  await upgradeTemplate.connect(votingSigner).startUpgrade({ gasLimit: TX_GAS_LIMIT });
  log("UpgradeTemplateV3 startUpgrade");

  const lidoRepo = await loadContract<Repo>("Repo", aragonLidoAppRepoAddress);
  await lidoRepo.connect(votingSigner).newVersion(lidoAppNewVersion, lidoImplAddress, "0x", { gasLimit: TX_GAS_LIMIT });
  log("Lido version updated in Lido App Repo");

  const aragonKernel = await loadContract<Kernel>("Kernel", kernelAddress);
  const appBasesNamespace = await aragonKernel.APP_BASES_NAMESPACE();
  const lidoAppId = state[Sk.appLido].aragonApp.id;
  await aragonKernel
    .connect(votingSigner)
    .setApp(appBasesNamespace, lidoAppId, lidoImplAddress, { gasLimit: TX_GAS_LIMIT });
  log("Lido upgraded to implementation", lidoImplAddress);

  const oldBurner = await loadContract<Burner>("Burner", oldBurnerAddress);
  const REQUEST_BURN_SHARES_ROLE = await oldBurner.REQUEST_BURN_SHARES_ROLE();
  const contractsWithTheRole = [
    lidoAddress,
    nodeOperatorsRegistryAddress,
    simpleDvtAddress,
    await getCSAccountingAddress(state),
  ];
  for (const address of contractsWithTheRole) {
    await oldBurner.connect(agentSigner).revokeRole(REQUEST_BURN_SHARES_ROLE, address, { gasLimit: TX_GAS_LIMIT });
    log("Burner revoked REQUEST_BURN_SHARES_ROLE from", address);
  }

  const accountingOracleProxy = await loadContract<OssifiableProxy>("OssifiableProxy", accountingOracleAddress);
  await accountingOracleProxy
    .connect(agentSigner)
    .proxy__upgradeTo(accountingOracleImplAddress, { gasLimit: TX_GAS_LIMIT });
  log("AccountingOracle upgraded to implementation", accountingOracleImplAddress);

  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  await stakingRouter
    .connect(agentSigner)
    .grantRole(await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), accountingAddress, { gasLimit: TX_GAS_LIMIT });
  log("StakingRouter granted REPORT_REWARDS_MINTED_ROLE to Accounting", accountingAddress);

  await upgradeTemplate.connect(votingSigner).finishUpgrade({ gasLimit: TX_GAS_LIMIT });
  log("UpgradeTemplateV3 finishUpgrade");

  await ethers.provider.send("evm_setAutomine", [true]);
  await mine(1);
}
