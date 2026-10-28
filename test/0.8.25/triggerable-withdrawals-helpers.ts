/**
 * Shared test helpers for TriggerableWithdrawalsBus and TriggerableWithdrawalsGateway tests.
 */
import { ethers } from "hardhat";

import { ONE_GWEI } from "lib";

/** Number of gwei in 1 ETH. */
export const GWEI_PER_ETH = ethers.WeiPerEther / ONE_GWEI;

/** Max amount of a single partial withdrawal request, in gwei (2048 - 32 = 2016 ETH). */
export const MAX_PWR_AMOUNT_GWEI = 2016n * GWEI_PER_ETH;

export type WithdrawalIntent = { amount: bigint; pubkey: string };

/** Parameters of a gateway quota, as `ITriggerableWithdrawalsGateway.LimitConfig`. */
export type LimitConfig = { maxLimit: bigint; limitPerFrame: bigint; frameDurationInSec: bigint };

/** A disabled gateway quota. */
export const DISABLED_LIMIT: LimitConfig = { maxLimit: 0n, limitPerFrame: 0n, frameDurationInSec: 0n };

/**
 * Default consumer limits in tests, with frames of 1,000 seconds:
 * PWR 10,000 ETH max, 32 ETH restored per frame; FWR 100 validators max, 1 restored per frame.
 */
export const DEFAULT_CONSUMER_LIMITS: { pwr: LimitConfig; fwr: LimitConfig } = {
  pwr: { maxLimit: 10_000n * GWEI_PER_ETH, limitPerFrame: 32n * GWEI_PER_ETH, frameDurationInSec: 1_000n },
  fwr: { maxLimit: 100n, limitPerFrame: 1n, frameDurationInSec: 1_000n },
};

/** Converts a `LimitConfig` into the tuple an event argument is compared with. */
export const toTuple = (config: LimitConfig) => [config.maxLimit, config.limitPerFrame, config.frameDurationInSec];

/** Deterministic 48-byte pubkey with non-zero bytes in both its 32-byte head and 16-byte tail. */
export const pubkeyAt = (i: number): string =>
  ethers.concat([ethers.id(`pubkey-head:${i}`), ethers.dataSlice(ethers.id(`pubkey-tail:${i}`), 0, 16)]);

/** Full withdrawal intent for the i-th test pubkey. */
export const fullWithdrawal = (i: number): WithdrawalIntent => ({ amount: 0n, pubkey: pubkeyAt(i) });

/** Partial withdrawal intent for the i-th test pubkey, `amount` in gwei. */
export const partialWithdrawal = (i: number, amount: bigint): WithdrawalIntent => ({ amount, pubkey: pubkeyAt(i) });

/** Converts `WithdrawalIntent[]` returned by a contract call into plain objects. */
export const toIntents = (result: { amount: bigint; pubkey: string }[]): WithdrawalIntent[] =>
  result.map(({ amount, pubkey }) => ({ amount, pubkey }));
