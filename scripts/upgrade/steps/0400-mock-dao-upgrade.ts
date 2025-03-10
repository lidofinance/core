import {
  AccountingOracle,
  Kernel,
  Lido,
  OssifiableProxy,
  Repo,
  StakingRouter,
  UpgradeTemplateV3,
  WithdrawalsManagerProxy,
  WithdrawalVault,
} from "typechain-types";

import { ether, log } from "lib";
import { impersonate } from "lib/account";
import { loadContract } from "lib/contract";
import { readNetworkState, Sk } from "lib/state-file";

import { readUpgradeParameters } from "../upgrade-utils";

const MAINNET_LIDO_REPO = "0xF5Dc67E54FC96F993CD06073f71ca732C1E654B1";

export async function main(): Promise<void> {
  const state = readNetworkState();
  const locatorAddress = state[Sk.lidoLocator].proxy.address;
  const agentAddress = state[Sk.appAgent].proxy.address;
  const votingAddress = state[Sk.appVoting].proxy.address;
  const lidoAddress = state[Sk.appLido].proxy.address;
  const locatorImplAddress = state[Sk.lidoLocator].implementation.address;
  const lidoImplAddress = state[Sk.appLido].implementation.address;
  const withdrawalVaultAddress = state[Sk.withdrawalVault].proxy.address;
  const withdrawalVaultImplAddress = state[Sk.withdrawalVault].implementation.address;
  const accountingOracleImplAddress = state[Sk.accountingOracle].implementation.address;
  const kernelAddress = state[Sk.aragonKernel].proxy.address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const validatorsExitBusOracleAddress = state[Sk.validatorsExitBusOracle].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const upgradeTemplateV3Address = state[Sk.upgradeTemplateV3].address;

  const parameters = readUpgradeParameters();
  const aoConsensusVersion = parameters[Sk.accountingOracle].deployParameters.consensusVersion;

  const agentSigner = await impersonate(agentAddress, ether("1"));
  const votingSigner = await impersonate(votingAddress, ether("1"));

  const locatorProxy = await loadContract<OssifiableProxy>("OssifiableProxy", locatorAddress);
  await locatorProxy.connect(agentSigner).proxy__upgradeTo(locatorImplAddress);
  log("LidoLocator upgraded to implementation", locatorImplAddress);

  const withdrawalsManagerProxy = await loadContract<WithdrawalsManagerProxy>(
    "WithdrawalsManagerProxy",
    withdrawalVaultAddress,
  );
  await withdrawalsManagerProxy.connect(votingSigner).proxy_upgradeTo(withdrawalVaultImplAddress, "0x");
  log("WithdrawalsManagerProxy upgraded to implementation", withdrawalVaultImplAddress);

  // This step is required to grant ADD_FULL_WITHDRAWAL_REQUEST_ROLE in the next step
  const withdrawalVault = await loadContract<WithdrawalVault>("WithdrawalVault", withdrawalVaultAddress);
  await withdrawalVault.connect(votingSigner).finalizeUpgrade_v2(agentAddress); // can be called by anyone
  log("WithdrawalVault finalizeUpgrade_v2 with admin", agentAddress);

  const addFullWithdrawalRequestRole = await withdrawalVault.ADD_FULL_WITHDRAWAL_REQUEST_ROLE();
  await withdrawalVault.connect(agentSigner).grantRole(addFullWithdrawalRequestRole, validatorsExitBusOracleAddress);
  log(
    "WithdrawalVault granted ADD_FULL_WITHDRAWAL_REQUEST_ROLE to ValidatorsExitBusOracle",
    validatorsExitBusOracleAddress,
  );

  const lidoRepo = await loadContract<Repo>("Repo", MAINNET_LIDO_REPO);
  await lidoRepo.connect(votingSigner).newVersion([5, 0, 0], lidoImplAddress, "0x");
  log("Lido version updated in Lido App Repo");

  const aragonKernel = await loadContract<Kernel>("Kernel", kernelAddress);
  const appBasesNamespace = await aragonKernel.APP_BASES_NAMESPACE();
  const lidoAppId = state[Sk.appLido].aragonApp.id;
  await aragonKernel.connect(votingSigner).setApp(appBasesNamespace, lidoAppId, lidoImplAddress);
  log("Lido upgraded to implementation", lidoImplAddress);

  const lido = await loadContract<Lido>("Lido", lidoAddress);
  await lido.connect(votingSigner).finalizeUpgrade_v3(); // can be called by anyone
  log("Lido finalizeUpgrade_v3");

  const accountingOracleProxy = await loadContract<OssifiableProxy>("OssifiableProxy", accountingOracleAddress);
  await accountingOracleProxy.connect(agentSigner).proxy__upgradeTo(accountingOracleImplAddress);
  log("AccountingOracle upgraded to implementation", accountingOracleImplAddress);

  const accountingOracle = await loadContract<AccountingOracle>(
    "AccountingOracle",
    state[Sk.accountingOracle].proxy.address,
  );
  await accountingOracle.connect(agentSigner).finalizeUpgrade_v3(aoConsensusVersion); // can be called by anyone
  log("AccountingOracle finalizeUpgrade_v3 with consensus version", aoConsensusVersion);

  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  await stakingRouter
    .connect(agentSigner)
    .grantRole(await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), accountingAddress);
  log("StakingRouter granted REPORT_REWARDS_MINTED_ROLE to Accounting", accountingAddress);

  const upgradeTemplate = await loadContract<UpgradeTemplateV3>("UpgradeTemplateV3", upgradeTemplateV3Address);
  await upgradeTemplate.connect(votingSigner).finishUpgrade();
  log("UpgradeTemplateV3 finishUpgrade");
}
