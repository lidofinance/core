import { ZeroAddress } from "ethers";

import { certainAddress, ether, getCurrentBlockTimestamp, impersonate, log } from "lib";

import { SHARE_RATE_PRECISION } from "test/suite";

import { ProtocolContext } from "../types";

import { report } from "./accounting";

const DEPOSIT = 10000;
const MIN_BURN = 1;
const BIG_BAG = ether("100000000000");

const DYNAMIC_SHARE_RATE = process.env.INTEGRATION_DYNAMIC_SHARE_RATE === "true";
const SHARES_TO_BURN = process.env.INTEGRATION_SHARES_TO_BURN ? Number(process.env.INTEGRATION_SHARES_TO_BURN) : null;

function calculateShareRate(totalPooledEther: bigint, totalShares: bigint): bigint {
  return (totalPooledEther * SHARE_RATE_PRECISION) / totalShares;
}

function logShareRate(shareRate: bigint): number {
  return Number(shareRate) / Number(SHARE_RATE_PRECISION);
}

async function changeInternalEther(ctx: ProtocolContext, internalEtherDelta: bigint) {
  const { lido, accounting } = ctx.contracts;

  const accountingSigner = await impersonate(accounting, ether("1"));

  const { beaconValidators, beaconBalance } = await lido.getBeaconStat();

  await lido
    .connect(accountingSigner)
    .processClStateUpdate(
      await getCurrentBlockTimestamp(),
      beaconValidators,
      beaconValidators,
      beaconBalance + internalEtherDelta,
    );
}

export const ensureExactShareRate = async (ctx: ProtocolContext, targetShareRate: bigint) => {
  const { lido } = ctx.contracts;

  const [totalPooledEther, totalShares] = await Promise.all([lido.getTotalPooledEther(), lido.getTotalShares()]);
  if (totalPooledEther * SHARE_RATE_PRECISION === totalShares * targetShareRate) {
    return;
  }

  const etherAmount = (totalShares * targetShareRate) / SHARE_RATE_PRECISION - totalPooledEther;

  await changeInternalEther(ctx, etherAmount);

  const [totalPooledEtherAfter, totalSharesAfter] = await Promise.all([
    lido.getTotalPooledEther(),
    lido.getTotalShares(),
  ]);
  const newShareRate = calculateShareRate(totalPooledEtherAfter, totalSharesAfter);

  log.success("Share rate:", logShareRate(newShareRate));
};

export const ensureSomeOddShareRate = async (ctx: ProtocolContext) => {
  const { lido, locator } = ctx.contracts;

  // Get current share rate
  const [totalPooledEther, totalShares] = await Promise.all([lido.getTotalPooledEther(), lido.getTotalShares()]);
  const currentShareRate = calculateShareRate(totalPooledEther, totalShares);

  if (currentShareRate !== SHARE_RATE_PRECISION) {
    log.success("Share rate:", logShareRate(currentShareRate));
    return;
  }

  // Impersonate whale and burner accounts
  const whaleAddress = certainAddress("shareRate:eth:whale");
  const burnerAddress = await locator.burner();
  const [whale, burner] = await Promise.all([impersonate(whaleAddress, BIG_BAG), impersonate(burnerAddress, BIG_BAG)]);

  // Whale submits deposit
  await lido.connect(whale).submit(ZeroAddress, { value: ether(DEPOSIT.toString()) });

  // Calculate burn amount (either predefined or random)
  // by default, burn half of the deposit
  const burnAmount = DYNAMIC_SHARE_RATE
    ? (SHARES_TO_BURN ?? MIN_BURN + Math.floor(Math.random() * (DEPOSIT - MIN_BURN)))
    : DEPOSIT / 2;

  const sharesToBurn = ether(burnAmount.toString());
  log.warning("Burning shares:", burnAmount, "(* 10^18)");

  // Whale transfers shares to burner, burner burns shares
  await lido.connect(whale).transfer(burner, sharesToBurn);
  await lido.connect(burner).burnShares(sharesToBurn);

  // Report accounting
  await report(ctx, { clDiff: 0n });

  // Get new share rate
  const [totalPooledEtherAfter, totalSharesAfter] = await Promise.all([
    lido.getTotalPooledEther(),
    lido.getTotalShares(),
  ]);
  const newShareRate = calculateShareRate(totalPooledEtherAfter, totalSharesAfter);

  log.success("Share rate:", logShareRate(newShareRate));
};
