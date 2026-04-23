import { ethers } from "hardhat";

import {
  ACL,
  IAccountingOracleUpgrade,
  ILidoUpgrade,
  IOssifiableProxy,
  IStakingRouterUpgrade,
  ITriggerableWithdrawalsGatewayUpgrade,
  IUpgradeConfig,
  IValidatorsExitBusOracleUpgrade,
  IWithdrawalsManagerProxy,
  IWithdrawalVaultUpgrade,
  Kernel,
  Lido,
  UpgradeTemplate,
} from "typechain-types";

import {
  bl,
  encodeFunctionCall,
  FinalizeUpgradeArgs,
  getAddress,
  impersonate,
  loadContract,
  log,
  makeTx,
  or,
  rd,
  readNetworkState,
  Sk,
  yl,
} from "lib";

export async function main() {
  const deployer = await ethers.provider.getSigner();
  const state = readNetworkState();
  // const parameters = readUpgradeParameters();

  const agentAddress = getAddress(Sk.appAgent, state);
  const agent = await impersonate(agentAddress, ethers.parseEther("100"));

  const templateAddress = getAddress(Sk.upgradeTemplate, state);
  const template = await loadContract<UpgradeTemplate>("UpgradeTemplate", templateAddress, deployer);
  const isFinished = await template.isUpgradeFinished();
  const expectedLidoVersion = await template.EXPECTED_FINAL_LIDO_VERSION();

  const lidoAddress = getAddress(Sk.appLido, state);
  const lido = await loadContract<Lido>("Lido", lidoAddress, deployer);
  const lidoVersion = await lido.getContractVersion();

  if (isFinished || lidoVersion >= expectedLidoVersion) {
    log.warning(`Upgrade already finished!!! Skipping...`);
    return;
  }

  const upgConfigAddress = await template.CONFIG();
  const upgConfig = await loadContract<IUpgradeConfig>("IUpgradeConfig", upgConfigAddress, agent);
  const g = await upgConfig.getGlobalConfig();
  const c = await upgConfig.getCoreUpgradeConfig();

  ///
  /// @dev voting items simulation (only Core part, NO EasyTracks, NO CSM)
  ///
  log(`Upgrade ${yl("LidoLocator")}[${bl(c.locator)}] to impl ${bl(c.newLocatorImpl)}`);
  const locatorProxy = await loadContract<IOssifiableProxy>("IOssifiableProxy", c.locator, agent);
  await makeTx(locatorProxy, "proxy__upgradeTo", [c.newLocatorImpl], { from: agentAddress });

  log(`Upgrade ${yl("StakingRouter")}[${bl(g.stakingRouter)}] to impl ${bl(c.newStakingRouterImpl)}`);
  const srProxy = await loadContract<IOssifiableProxy>("IOssifiableProxy", g.stakingRouter, agent);
  await makeTx(
    srProxy,
    "proxy__upgradeToAndCall",
    [
      c.newStakingRouterImpl,
      await encodeFunctionCall<FinalizeUpgradeArgs<IStakingRouterUpgrade, "v4">>(
        "IStakingRouterUpgrade",
        "finalizeUpgrade_v4",
        [],
      ),
      false,
    ],
    { from: agentAddress },
  );

  log(`Upgrade ${yl("AccountingOracle")}[${bl(c.accountingOracle)}] to impl ${bl(c.newAccountingOracleImpl)}`);
  const aoProxy = await loadContract<IOssifiableProxy>("IOssifiableProxy", c.accountingOracle, agent);
  await makeTx(
    aoProxy,
    "proxy__upgradeToAndCall",
    [
      c.newAccountingOracleImpl,
      await encodeFunctionCall<FinalizeUpgradeArgs<IAccountingOracleUpgrade, "v5">>(
        "IAccountingOracleUpgrade",
        "finalizeUpgrade_v5",
        [c.aoConsensusVersion],
      ),
      false,
    ],
    { from: agentAddress },
  );

  log(
    `Upgrade ${yl("ValidatorsExitBusOracle")}[${bl(c.validatorsExitBusOracle)}] to impl ${bl(c.newValidatorsExitBusOracleImpl)}`,
  );
  const veboProxy = await loadContract<IOssifiableProxy>("IOssifiableProxy", c.validatorsExitBusOracle, agent);
  await makeTx(
    veboProxy,
    "proxy__upgradeToAndCall",
    [
      c.newValidatorsExitBusOracleImpl,
      await encodeFunctionCall<FinalizeUpgradeArgs<IValidatorsExitBusOracleUpgrade, "v3">>(
        "IValidatorsExitBusOracleUpgrade",
        "finalizeUpgrade_v3",
        [
          c.veboMaxValidatorsPerReport,
          c.veboMaxExitBalanceEth,
          c.veboBalancePerFrameEth,
          c.veboFrameDurationInSec,
          c.veboConsensusVersion,
        ],
      ),
      false,
    ],
    { from: agentAddress },
  );

  log(`Upgrade ${yl("Accounting")}[${bl(c.accounting)}] to impl ${bl(c.newAccountingImpl)}`);
  const accProxy = await loadContract<IOssifiableProxy>("IOssifiableProxy", c.accounting, agent);
  await makeTx(accProxy, "proxy__upgradeTo", [c.newAccountingImpl], { from: agentAddress });

  const wvProxy = await loadContract<IWithdrawalsManagerProxy>("IWithdrawalsManagerProxy", c.withdrawalVault, agent);
  await makeTx(
    wvProxy,
    "proxy_upgradeTo",
    [
      c.newWithdrawalVaultImpl,
      await encodeFunctionCall<FinalizeUpgradeArgs<IWithdrawalVaultUpgrade, "v3">>(
        "IWithdrawalVaultUpgrade",
        "finalizeUpgrade_v3",
        [],
      ),
    ],
    { from: agentAddress },
  );

  log(`Upgrade ${yl("Lido")}[${bl(g.lido)}] to impl ${bl(c.newLidoImpl)}`);
  const kernel = await loadContract<Kernel>("Kernel", c.kernel, agent);
  const APP_MANAGER_ROLE = await kernel.APP_MANAGER_ROLE();
  const acl = await loadContract<ACL>("ACL", c.acl, agent);
  await makeTx(acl, "grantPermission", [agentAddress, c.kernel, APP_MANAGER_ROLE], { from: agentAddress });

  await makeTx(kernel, "setApp", [await kernel.APP_BASES_NAMESPACE(), c.lidoAppId, c.newLidoImpl], {
    from: agentAddress,
  });
  const BUFFER_RESERVE_MANAGER_ROLE = await lido.BUFFER_RESERVE_MANAGER_ROLE();
  await makeTx(acl, "createPermission", [agentAddress, lidoAddress, BUFFER_RESERVE_MANAGER_ROLE, agentAddress], {
    from: agentAddress,
  });

  await makeTx(acl, "revokePermission", [agentAddress, c.kernel, APP_MANAGER_ROLE], { from: agentAddress });

  const lidoUpg = await loadContract<ILidoUpgrade>("Lido", g.lido, agent);
  await makeTx(lidoUpg, "finalizeUpgrade_v4", [], { from: agentAddress });

  const sr = await loadContract<IStakingRouterUpgrade>("IStakingRouterUpgrade", g.stakingRouter, agent);
  log(
    `grantRole on ${yl("StakingRouter")}[${bl(sr.address)}]:${or("STAKING_MODULE_SHARE_MANAGE_ROLE")} to  ${bl(g.easyTrackEVMScriptExecutor)}`,
  );
  await makeTx(sr, "grantRole", [await sr.STAKING_MODULE_SHARE_MANAGE_ROLE(), g.easyTrackEVMScriptExecutor], {
    from: agentAddress,
  });
  log(
    `revokeRole on ${yl("StakingRouter")}[${bl(sr.address)}]:${or("STAKING_MODULE_UNVETTING_ROLE")} from  ${bl(c.oldDepositSecurityModule)}`,
  );
  await makeTx(sr, "revokeRole", [await sr.STAKING_MODULE_UNVETTING_ROLE(), c.oldDepositSecurityModule], {
    from: agentAddress,
  });
  log(
    rd("VOTE ITEM:"),
    `grantRole on ${yl("StakingRouter")}[${bl(sr.address)}]:${or("STAKING_MODULE_UNVETTING_ROLE")} to  ${bl(c.newDepositSecurityModule)}`,
  );
  await makeTx(sr, "grantRole", [await sr.STAKING_MODULE_UNVETTING_ROLE(), c.newDepositSecurityModule], {
    from: agentAddress,
  });

  const twg = await loadContract<ITriggerableWithdrawalsGatewayUpgrade>(
    "ITriggerableWithdrawalsGatewayUpgrade",
    g.triggerableWithdrawalsGateway,
    agent,
  );
  log(`grantRole on ${yl("TWG")}[${bl(twg.address)}]:${or("TW_EXIT_LIMIT_MANAGER_ROLE")} to  ${bl(agentAddress)}`);
  await makeTx(twg, "grantRole", [await twg.TW_EXIT_LIMIT_MANAGER_ROLE(), agentAddress], {
    from: agentAddress,
  });
  log(
    `call  ${yl("TWG")}[${bl(twg.address)}]:${or("setExitRequestLimit")} [${[c.twMaxExitRequestsLimit, c.twExitsPerFrame, c.twFrameDurationInSec]}]`,
  );

  await makeTx(twg, "setExitRequestLimit", [c.twMaxExitRequestsLimit, c.twExitsPerFrame, c.twFrameDurationInSec], {
    from: agentAddress,
  });

  // const cb = await loadContract<ICircuitBreaker>("ICircuitBreaker", g.circuitBreaker, agent);
  // await makeTx(cb, "registerPauser", [c.consolidationGateway, c.curatedModuleCommittee], {
  //   from: agentAddress,
  // });
}
