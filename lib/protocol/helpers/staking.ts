import { ZeroAddress } from "ethers";

import { certainAddress, ether, impersonate, log, trace } from "lib";

import { ZERO_HASH } from "test/deploy";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

const AMOUNT = ether("100");
const MAX_DEPOSIT = 150n;
const CURATED_MODULE_ID = 1n;
const SIMPLE_DVT_MODULE_ID = 2n;

/**
 * Unpauses the staking contract.
 */
export const unpauseStaking = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;
  if (await lido.isStakingPaused()) {
    log.warning("Unpausing staking contract");

    const votingSigner = await ctx.getSigner("voting");
    const tx = await lido.connect(votingSigner).resume();
    await trace("lido.resume", tx);

    log.success("Staking contract unpaused");
  }
};

export const ensureStakeLimit = async (ctx: ProtocolContext) => {
  const { lido } = ctx.contracts;

  const stakeLimitInfo = await lido.getStakeLimitFullInfo();
  if (!stakeLimitInfo.isStakingLimitSet) {
    log.warning("Setting staking limit");

    const maxStakeLimit = ether("150000");
    const stakeLimitIncreasePerBlock = ether("20"); // this is an arbitrary value

    const votingSigner = await ctx.getSigner("voting");
    const tx = await lido.connect(votingSigner).setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock);
    await trace("lido.setStakingLimit", tx);

    log.success("Staking limit set");
  }
};

export const depositAndReportValidators = async (ctx: ProtocolContext) => {
  const { lido, depositSecurityModule } = ctx.contracts;
  const ethHolder = await impersonate(certainAddress("provision:eht:whale"), ether("100000"));

  await lido.connect(ethHolder).submit(ZeroAddress, { value: ether("10000") });

  // Deposit node operators
  const dsmSigner = await impersonate(depositSecurityModule.address, AMOUNT);
  await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
  await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, SIMPLE_DVT_MODULE_ID, ZERO_HASH);

  const before = await lido.getBeaconStat();

  log.debug("Validators on beacon chain before provisioning", {
    depositedValidators: before.depositedValidators,
    beaconValidators: before.beaconValidators,
    beaconBalance: before.beaconBalance,
  });

  // Add new validators to beacon chain
  await report(ctx, {
    clDiff: ether("32") * before.depositedValidators,
    clAppearedValidators: before.depositedValidators,
  });

  const after = await lido.getBeaconStat();

  log.debug("Validators on beacon chain after provisioning", {
    depositedValidators: after.depositedValidators,
    beaconValidators: after.beaconValidators,
    beaconBalance: after.beaconBalance,
  });
};
