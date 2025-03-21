import { mine } from "@nomicfoundation/hardhat-network-helpers";

import {
  AccountingOracle,
  Kernel,
  Lido,
  LidoLocator,
  OssifiableProxy,
  Repo,
  StakingRouter,
  UpgradeTemplateV3,
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
  const accountingOracleImplAddress = state[Sk.accountingOracle].implementation.address;
  const kernelAddress = state[Sk.aragonKernel].proxy.address;
  const stakingRouterAddress = state[Sk.stakingRouter].proxy.address;
  const accountingAddress = state[Sk.accounting].proxy.address;
  const accountingOracleAddress = state[Sk.accountingOracle].proxy.address;
  const upgradeTemplateV3Address = state[Sk.upgradeTemplateV3].address;
  const simpleDvtAddress = state[Sk.appSimpleDvt].proxy.address;
  const nodeOperatorsRegistryAddress = state[Sk.appNodeOperatorsRegistry].proxy.address;

  // Disable automine to ensure all transactions happen in the same block
  // TODO: automine false and mempool fifo order and manual nonce management still doesn't work!
  // await mine(1);
  // await ethers.provider.send("evm_setAutomine", [false]);

  // while locator is not upgraded yet we can fetch the old burner address
  const locator = await loadContract<LidoLocator>("LidoLocator", locatorAddress);
  const oldBurnerAddress = locator.burner();

  const parameters = readUpgradeParameters();
  const aoConsensusVersion = parameters[Sk.accountingOracle].deployParameters.consensusVersion;
  const lidoAppNewVersion = parameters[Sk.appLido].newVersion;
  const csmAccountingAddress = parameters["csm"].accounting;

  const agentSigner = await impersonate(agentAddress, ether("1"));
  const votingSigner = await impersonate(votingAddress, ether("1"));

  let agentNonce = await agentSigner.getNonce();
  let votingNonce = await votingSigner.getNonce();

  const locatorProxy = await loadContract<OssifiableProxy>("OssifiableProxy", locatorAddress);
  await locatorProxy.connect(agentSigner).proxy__upgradeTo(locatorImplAddress, { nonce: agentNonce });
  agentNonce += 1;
  log("LidoLocator upgraded to implementation", locatorImplAddress);

  const upgradeTemplate = await loadContract<UpgradeTemplateV3>("UpgradeTemplateV3", upgradeTemplateV3Address);
  await upgradeTemplate.connect(votingSigner).startUpgrade({ nonce: votingNonce });
  votingNonce += 1;
  log("UpgradeTemplateV3 startUpgrade");

  const lidoRepo = await loadContract<Repo>("Repo", MAINNET_LIDO_REPO);
  await lidoRepo.connect(votingSigner).newVersion(lidoAppNewVersion, lidoImplAddress, "0x", { nonce: votingNonce });
  votingNonce += 1;
  log("Lido version updated in Lido App Repo");

  const aragonKernel = await loadContract<Kernel>("Kernel", kernelAddress);
  const appBasesNamespace = await aragonKernel.APP_BASES_NAMESPACE();
  const lidoAppId = state[Sk.appLido].aragonApp.id;
  await aragonKernel.connect(votingSigner).setApp(appBasesNamespace, lidoAppId, lidoImplAddress, { nonce: votingNonce });
  votingNonce += 1;
  log("Lido upgraded to implementation", lidoImplAddress);

  const lido = await loadContract<Lido>("Lido", lidoAddress);
  await lido
    .connect(votingSigner)
    .finalizeUpgrade_v3(oldBurnerAddress, simpleDvtAddress, nodeOperatorsRegistryAddress, csmAccountingAddress, { nonce: votingNonce }); // can be called by anyone
  votingNonce += 1;
  // NB: burner migration happens in Lido.finalizeUpgrade_v3()
  log("Lido finalizeUpgrade_v3");

  const accountingOracleProxy = await loadContract<OssifiableProxy>("OssifiableProxy", accountingOracleAddress);
  await accountingOracleProxy.connect(agentSigner).proxy__upgradeTo(accountingOracleImplAddress, { nonce: agentNonce });
  log("AccountingOracle upgraded to implementation", accountingOracleImplAddress);
  agentNonce += 1;

  const accountingOracle = await loadContract<AccountingOracle>(
    "AccountingOracle",
    state[Sk.accountingOracle].proxy.address,
  );
  await accountingOracle.connect(agentSigner).finalizeUpgrade_v3(aoConsensusVersion, { nonce: agentNonce }); // can be called by anyone
  log("AccountingOracle finalizeUpgrade_v3 with consensus version", aoConsensusVersion);
  agentNonce += 1;

  const stakingRouter = await loadContract<StakingRouter>("StakingRouter", stakingRouterAddress);
  await stakingRouter
    .connect(agentSigner)
    .grantRole(await stakingRouter.REPORT_REWARDS_MINTED_ROLE(), accountingAddress, { nonce: agentNonce });
  log("StakingRouter granted REPORT_REWARDS_MINTED_ROLE to Accounting", accountingAddress);
  agentNonce += 1;

  await upgradeTemplate.connect(votingSigner).finishUpgrade({ nonce: votingNonce });
  votingNonce += 1;
  log("UpgradeTemplateV3 finishUpgrade");

  // await ethers.provider.send("evm_setAutomine", [true]);

  await mine(1);
}
