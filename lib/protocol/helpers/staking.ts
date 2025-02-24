import { ethers, ZeroAddress } from "ethers";

import { certainAddress, ether, impersonate, log } from "lib";

import { ZERO_HASH } from "test/deploy";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

/**
 * Unpauses the staking contract.
 */
export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).resume();

    log.success("Staking contract unpaused");
  }
};

export const ensureStakeLimit = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;

  const stakeLimitInfo = await lido.getStakeLimitFullInfo();
  if (!stakeLimitInfo.isStakingLimitSet) {
    const maxStakeLimit = ether("150000");
    const stakeLimitIncreasePerBlock = ether("20"); // this is an arbitrary value

    log.debug("Setting staking limit", {
      "Max stake limit": ethers.formatEther(maxStakeLimit),
      "Stake limit increase per block": ethers.formatEther(stakeLimitIncreasePerBlock),
    });

    const votingSigner = await ctx.getSigner("voting");
    await lido.connect(votingSigner).setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);

    log.success("Staking limit set");
  }
};

export const depositAndReportValidators = async (ctx: ProtocolContext, moduleId: bigint, depositsCount: bigint) => {
  const { lido, depositSecurityModule } = ctx.contracts;
  const ethHolder = await impersonate(certainAddress("provision:eth:whale"), ether("100000"));

  await lido.connect(ethHolder).submit(ZeroAddress, { value: ether("10000") });

  // Deposit validators
  const dsmSigner = await impersonate(depositSecurityModule.address, ether("100000"));
  await lido.connect(dsmSigner).deposit(depositsCount, moduleId, ZERO_HASH);

  const before = await lido.getBeaconStat();

  log.debug("Validators on beacon chain before provisioning", {
    "Module ID to deposit": moduleId,
    "Deposited": before.depositedValidators,
    "Total": before.beaconValidators,
    "Balance": before.beaconBalance,
  });

  // Add new validators to beacon chain
  await report(ctx, {
    clDiff: ether("32") * depositsCount,
    clAppearedValidators: depositsCount,
  });

  const after = await lido.getBeaconStat();

  log.debug("Validators on beacon chain after depositing", {
    "Module ID deposited": moduleId,
    "Deposited": after.depositedValidators,
    "Total": after.beaconValidators,
    "Balance": after.beaconBalance,
  });
};
