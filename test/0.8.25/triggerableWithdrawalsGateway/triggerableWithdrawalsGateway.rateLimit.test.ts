import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsGateway } from "typechain-types";

import { advanceChainTime } from "lib";

import { deployTriggerableWithdrawalsGateway } from "test/deploy";
import { Snapshot } from "test/suite";

import {
  DEFAULT_CONSUMER_LIMITS,
  DISABLED_LIMIT,
  fullWithdrawal,
  GWEI_PER_ETH,
  LimitConfig,
  MAX_PWR_AMOUNT_GWEI,
  partialWithdrawal,
  toTuple,
  WithdrawalIntent,
} from "../triggerable-withdrawals-helpers";

const { pwr: PWR, fwr: FWR } = DEFAULT_CONSUMER_LIMITS;
const FRAME = PWR.frameDurationInSec;
const U64_MAX = 2n ** 64n - 1n;

describe("TriggerableWithdrawalsGateway.sol: consumer limits", () => {
  let gateway: TriggerableWithdrawalsGateway;
  let admin: HardhatEthersSigner;
  let limitManager: HardhatEthersSigner;
  let consumer: HardhatEthersSigner;
  let otherConsumer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, limitManager, consumer, otherConsumer, stranger] = await ethers.getSigners();

    ({ gateway } = await deployTriggerableWithdrawalsGateway(admin));

    await gateway.connect(admin).grantRole(await gateway.TW_EXIT_LIMIT_MANAGER_ROLE(), limitManager.address);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
    // Setting the limits of a new consumer starts its frames now: frames are long compared to the few seconds
    // between transactions in a test, so the restored quota below is exact in frames
    await gateway.connect(limitManager).setConsumerLimits(consumer.address, PWR, FWR);
  });

  afterEach(async () => await Snapshot.restore(originalState));

  const setLimits = (address: string, pwr: LimitConfig, fwr: LimitConfig) =>
    gateway.connect(limitManager).setConsumerLimits(address, pwr, fwr);

  const currentPwrLimit = async (address = consumer.address) =>
    (await gateway.getConsumerLimitsFullInfo(address)).pwrLimit.currentLimit;

  const currentFwrLimit = async (address = consumer.address) =>
    (await gateway.getConsumerLimitsFullInfo(address)).fwrLimit.currentLimit;

  const trigger = (signer: HardhatEthersSigner, intents: WithdrawalIntent[]) =>
    gateway.connect(signer).triggerWithdrawals(intents, signer.address, { value: BigInt(intents.length) });

  /** Consumes exactly `amountGwei` of the consumer's PWR limit with partial withdrawals. */
  const consumePwr = async (amountGwei: bigint, signer = consumer) => {
    const intents = [];
    for (let left = amountGwei, i = 0; left > 0n; ++i) {
      const chunk = left > MAX_PWR_AMOUNT_GWEI ? MAX_PWR_AMOUNT_GWEI : left;
      intents.push(partialWithdrawal(i, chunk));
      left -= chunk;
    }
    await trigger(signer, intents);
  };

  /** Consumes exactly `count` units of the consumer's FWR limit. */
  const consumeFwr = async (count: bigint, signer = consumer) =>
    trigger(
      signer,
      Array.from({ length: Number(count) }, (_, i) => fullWithdrawal(i)),
    );

  context("setConsumerLimits", () => {
    const NEW_PWR: LimitConfig = {
      maxLimit: 4096n * GWEI_PER_ETH,
      limitPerFrame: 64n * GWEI_PER_ETH,
      frameDurationInSec: 12n,
    };
    const NEW_FWR: LimitConfig = { maxLimit: 50n, limitPerFrame: 5n, frameDurationInSec: 24n };

    it("reverts if caller has no TW_EXIT_LIMIT_MANAGER_ROLE", async () => {
      await expect(gateway.connect(stranger).setConsumerLimits(otherConsumer.address, NEW_PWR, NEW_FWR))
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await gateway.TW_EXIT_LIMIT_MANAGER_ROLE());
    });

    it("reverts if the consumer is zero address", async () => {
      await expect(setLimits(ethers.ZeroAddress, NEW_PWR, NEW_FWR))
        .to.be.revertedWithCustomError(gateway, "ZeroArgument")
        .withArgs("consumer");
    });

    it("sets the limits of a new consumer full and emits ConsumerLimitsSet", async () => {
      await expect(setLimits(otherConsumer.address, NEW_PWR, NEW_FWR))
        .to.emit(gateway, "ConsumerLimitsSet")
        .withArgs(otherConsumer.address, toTuple(NEW_PWR), toTuple(NEW_FWR));

      const { pwrLimit, fwrLimit } = await gateway.getConsumerLimitsFullInfo(otherConsumer.address);
      expect(pwrLimit).to.deep.equal([...toTuple(NEW_PWR), NEW_PWR.maxLimit, NEW_PWR.maxLimit]);
      expect(fwrLimit).to.deep.equal([...toTuple(NEW_FWR), NEW_FWR.maxLimit, NEW_FWR.maxLimit]);
    });

    it("does not change the limits of other consumers", async () => {
      await consumePwr(1n);

      await setLimits(otherConsumer.address, NEW_PWR, NEW_FWR);

      const { pwrLimit, fwrLimit } = await gateway.getConsumerLimitsFullInfo(consumer.address);
      expect(pwrLimit).to.deep.equal([...toTuple(PWR), PWR.maxLimit - 1n, PWR.maxLimit - 1n]);
      expect(fwrLimit).to.deep.equal([...toTuple(FWR), FWR.maxLimit, FWR.maxLimit]);
    });

    it("accepts a disabled PWR limit", async () => {
      await setLimits(otherConsumer.address, DISABLED_LIMIT, NEW_FWR);

      const { pwrLimit } = await gateway.getConsumerLimitsFullInfo(otherConsumer.address);
      expect(pwrLimit).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
    });

    it("accepts a disabled FWR limit", async () => {
      await setLimits(otherConsumer.address, NEW_PWR, DISABLED_LIMIT);

      const { fwrLimit } = await gateway.getConsumerLimitsFullInfo(otherConsumer.address);
      expect(fwrLimit).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
    });

    it("unsets a consumer when both limits are disabled", async () => {
      await setLimits(consumer.address, DISABLED_LIMIT, DISABLED_LIMIT);

      const { pwrLimit, fwrLimit } = await gateway.getConsumerLimitsFullInfo(consumer.address);
      expect(pwrLimit).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
      expect(fwrLimit).to.deep.equal([0n, 0n, 0n, 0n, 0n]);
    });

    it("reverts if an enabled PWR limit is below the max partial withdrawal amount", async () => {
      const pwr = { maxLimit: MAX_PWR_AMOUNT_GWEI - 1n, limitPerFrame: 1n, frameDurationInSec: 1n };

      await expect(setLimits(otherConsumer.address, pwr, NEW_FWR))
        .to.be.revertedWithCustomError(gateway, "TooSmallMaxPwrLimit")
        .withArgs(MAX_PWR_AMOUNT_GWEI - 1n);
    });

    it("accepts a PWR limit equal to the max partial withdrawal amount", async () => {
      const pwr = { maxLimit: MAX_PWR_AMOUNT_GWEI, limitPerFrame: 1n, frameDurationInSec: 1n };

      await setLimits(otherConsumer.address, pwr, NEW_FWR);

      expect(await currentPwrLimit(otherConsumer.address)).to.equal(MAX_PWR_AMOUNT_GWEI);
    });

    it("accepts an FWR limit of one validator", async () => {
      const fwr = { maxLimit: 1n, limitPerFrame: 1n, frameDurationInSec: 1n };

      await setLimits(otherConsumer.address, NEW_PWR, fwr);

      expect(await currentFwrLimit(otherConsumer.address)).to.equal(1n);
    });

    it("accepts limits at the uint64 and uint32 bounds", async () => {
      const max = { maxLimit: U64_MAX, limitPerFrame: U64_MAX, frameDurationInSec: 2n ** 32n - 1n };

      await setLimits(otherConsumer.address, max, max);

      expect(await currentPwrLimit(otherConsumer.address)).to.equal(U64_MAX);
      expect(await currentFwrLimit(otherConsumer.address)).to.equal(U64_MAX);
    });

    const invalidConfigs: { name: string; config: (base: LimitConfig) => LimitConfig; error: string }[] = [
      {
        name: "a disabled limit has a restore rate",
        config: () => ({ maxLimit: 0n, limitPerFrame: 1n, frameDurationInSec: 0n }),
        error: "InvalidDisabledLimit",
      },
      {
        name: "a disabled limit has a frame duration",
        config: () => ({ maxLimit: 0n, limitPerFrame: 0n, frameDurationInSec: 1n }),
        error: "InvalidDisabledLimit",
      },
      {
        name: "the limit per frame is zero",
        config: (base) => ({ ...base, limitPerFrame: 0n }),
        error: "ZeroLimitPerFrame",
      },
      {
        name: "the limit per frame exceeds the max limit",
        config: (base) => ({ ...base, limitPerFrame: base.maxLimit + 1n }),
        error: "TooLargeLimitPerFrame",
      },
      {
        name: "the frame duration is zero",
        config: (base) => ({ ...base, frameDurationInSec: 0n }),
        error: "ZeroFrameDuration",
      },
      {
        name: "the frame duration exceeds uint32",
        config: (base) => ({ ...base, frameDurationInSec: 2n ** 32n }),
        error: "TooLargeFrameDuration",
      },
      {
        name: "the max limit exceeds uint64",
        config: (base) => ({ ...base, maxLimit: 2n ** 64n }),
        error: "TooLargeMaxLimit",
      },
    ];

    for (const { name, config, error } of invalidConfigs) {
      it(`reverts if in the PWR limit ${name}`, async () => {
        await expect(setLimits(otherConsumer.address, config(NEW_PWR), NEW_FWR)).to.be.revertedWithCustomError(
          gateway,
          error,
        );
      });

      it(`reverts if in the FWR limit ${name}`, async () => {
        await expect(setLimits(otherConsumer.address, NEW_PWR, config(NEW_FWR))).to.be.revertedWithCustomError(
          gateway,
          error,
        );
      });
    }

    it("keeps the quota restored since the last request", async () => {
      await consumePwr(PWR.maxLimit);
      await consumeFwr(FWR.maxLimit);
      await advanceChainTime(3n * FRAME);
      expect(await currentPwrLimit()).to.equal(3n * PWR.limitPerFrame);
      expect(await currentFwrLimit()).to.equal(3n * FWR.limitPerFrame);

      await setLimits(consumer.address, PWR, FWR);

      expect(await currentPwrLimit()).to.equal(3n * PWR.limitPerFrame);
      expect(await currentFwrLimit()).to.equal(3n * FWR.limitPerFrame);
    });

    it("caps the current limit by a lower max limit", async () => {
      await consumePwr(1000n * GWEI_PER_ETH);
      await consumeFwr(10n);

      await setLimits(consumer.address, NEW_PWR, NEW_FWR);

      expect(await currentPwrLimit()).to.equal(NEW_PWR.maxLimit);
      expect(await currentFwrLimit()).to.equal(NEW_FWR.maxLimit);
    });

    it("does not increase the current limit when the max limit grows", async () => {
      await consumePwr(1000n * GWEI_PER_ETH);
      await consumeFwr(10n);

      await setLimits(
        consumer.address,
        { ...PWR, maxLimit: PWR.maxLimit * 2n },
        { ...FWR, maxLimit: FWR.maxLimit * 2n },
      );

      expect(await currentPwrLimit()).to.equal(PWR.maxLimit - 1000n * GWEI_PER_ETH);
      expect(await currentFwrLimit()).to.equal(FWR.maxLimit - 10n);
    });

    it("starts a limit full when it is enabled again", async () => {
      await consumePwr(1000n * GWEI_PER_ETH);
      await consumeFwr(10n);

      await setLimits(consumer.address, DISABLED_LIMIT, FWR);
      await setLimits(consumer.address, PWR, FWR);

      expect(await currentPwrLimit()).to.equal(PWR.maxLimit);
      // The FWR limit stayed enabled, so its consumed quota is carried over
      expect(await currentFwrLimit()).to.equal(FWR.maxLimit - 10n);
    });
  });

  context("consumption", () => {
    it("reverts full withdrawals of a caller without limits", async () => {
      await expect(trigger(stranger, [fullWithdrawal(0)]))
        .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
        .withArgs(1, 0);
    });

    it("reverts partial withdrawals of a caller without limits", async () => {
      await expect(trigger(stranger, [partialWithdrawal(0, 1n)]))
        .to.be.revertedWithCustomError(gateway, "PwrLimitExceeded")
        .withArgs(1, 0);
    });

    it("rejects partial withdrawals but accepts full ones if the PWR limit is disabled", async () => {
      await setLimits(otherConsumer.address, DISABLED_LIMIT, FWR);

      await expect(trigger(otherConsumer, [partialWithdrawal(0, 1n)]))
        .to.be.revertedWithCustomError(gateway, "PwrLimitExceeded")
        .withArgs(1, 0);
      await expect(trigger(otherConsumer, [fullWithdrawal(0)])).to.emit(gateway, "WithdrawalsTriggered");

      expect(await currentFwrLimit(otherConsumer.address)).to.equal(FWR.maxLimit - 1n);
    });

    it("rejects full withdrawals but accepts partial ones if the FWR limit is disabled", async () => {
      await setLimits(otherConsumer.address, PWR, DISABLED_LIMIT);

      await expect(trigger(otherConsumer, [fullWithdrawal(0)]))
        .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
        .withArgs(1, 0);
      await expect(trigger(otherConsumer, [partialWithdrawal(0, 1n)])).to.emit(gateway, "WithdrawalsTriggered");

      expect(await currentPwrLimit(otherConsumer.address)).to.equal(PWR.maxLimit - 1n);
    });

    it("allows partial withdrawals that exactly exhaust the PWR limit and keeps the FWR limit", async () => {
      await consumePwr(PWR.maxLimit);

      expect(await currentPwrLimit()).to.equal(0);
      expect(await currentFwrLimit()).to.equal(FWR.maxLimit);
    });

    it("allows full withdrawals that exactly exhaust the FWR limit and keeps the PWR limit", async () => {
      await consumeFwr(FWR.maxLimit);

      expect(await currentFwrLimit()).to.equal(0);
      expect(await currentPwrLimit()).to.equal(PWR.maxLimit);
    });

    it("counts partial withdrawals to the gwei", async () => {
      await consumePwr(1n);

      expect(await currentPwrLimit()).to.equal(PWR.maxLimit - 1n);
    });

    it("counts a full withdrawal as one validator", async () => {
      await trigger(consumer, [fullWithdrawal(0)]);

      expect(await currentFwrLimit()).to.equal(FWR.maxLimit - 1n);
      expect(await currentPwrLimit()).to.equal(PWR.maxLimit);
    });

    it("reverts the whole batch if its partial withdrawals exceed the remaining PWR limit", async () => {
      const remaining = 5n * GWEI_PER_ETH;
      await consumePwr(PWR.maxLimit - remaining);

      await expect(trigger(consumer, [fullWithdrawal(0), partialWithdrawal(1, remaining + 1n)]))
        .to.be.revertedWithCustomError(gateway, "PwrLimitExceeded")
        .withArgs(remaining + 1n, remaining);

      expect(await currentPwrLimit()).to.equal(remaining);
      expect(await currentFwrLimit()).to.equal(FWR.maxLimit);
    });

    it("reverts the whole batch if its full withdrawals exceed the remaining FWR limit", async () => {
      await consumeFwr(FWR.maxLimit - 1n);

      await expect(trigger(consumer, [fullWithdrawal(0), partialWithdrawal(1, 1n), fullWithdrawal(2)]))
        .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
        .withArgs(2, 1);

      expect(await currentFwrLimit()).to.equal(1);
      expect(await currentPwrLimit()).to.equal(PWR.maxLimit);
    });

    it("keeps the quotas of consumers separate", async () => {
      await setLimits(otherConsumer.address, PWR, FWR);
      await consumePwr(PWR.maxLimit);
      await consumeFwr(FWR.maxLimit);

      await expect(trigger(otherConsumer, [fullWithdrawal(0), partialWithdrawal(1, MAX_PWR_AMOUNT_GWEI)])).to.emit(
        gateway,
        "WithdrawalsTriggered",
      );

      expect(await currentPwrLimit(otherConsumer.address)).to.equal(PWR.maxLimit - MAX_PWR_AMOUNT_GWEI);
      expect(await currentFwrLimit(otherConsumer.address)).to.equal(FWR.maxLimit - 1n);
      expect(await currentPwrLimit()).to.equal(0);
      expect(await currentFwrLimit()).to.equal(0);
    });
  });

  context("restoration", () => {
    beforeEach(async () => {
      await consumePwr(PWR.maxLimit);
      await consumeFwr(FWR.maxLimit);
    });

    it("does not restore the limits within a frame", async () => {
      await advanceChainTime(FRAME / 2n);

      expect(await currentPwrLimit()).to.equal(0);
      expect(await currentFwrLimit()).to.equal(0);
    });

    it("restores the limit per frame for each passed frame", async () => {
      await advanceChainTime(5n * FRAME);

      expect(await currentPwrLimit()).to.equal(5n * PWR.limitPerFrame);
      expect(await currentFwrLimit()).to.equal(5n * FWR.limitPerFrame);
    });

    it("caps the restored limits by the max limits", async () => {
      await advanceChainTime((FWR.maxLimit / FWR.limitPerFrame + PWR.maxLimit / PWR.limitPerFrame) * FRAME);

      expect(await currentPwrLimit()).to.equal(PWR.maxLimit);
      expect(await currentFwrLimit()).to.equal(FWR.maxLimit);
    });

    it("restores without overflow at the uint64 bounds", async () => {
      // The exhausted quotas are carried over, so the limits start empty
      const max = { maxLimit: U64_MAX, limitPerFrame: U64_MAX, frameDurationInSec: FRAME };
      await setLimits(consumer.address, max, max);
      await advanceChainTime(2n * FRAME);

      // The quota restored in two frames exceeds uint64 before the cap is applied
      expect(await currentPwrLimit()).to.equal(U64_MAX);
      expect(await currentFwrLimit()).to.equal(U64_MAX);
    });

    it("lets a full withdrawal through once one validator of quota is restored", async () => {
      await advanceChainTime(FRAME / 2n);

      await expect(trigger(consumer, [fullWithdrawal(0)]))
        .to.be.revertedWithCustomError(gateway, "FwrLimitExceeded")
        .withArgs(1, 0);

      await advanceChainTime(FRAME / 2n);

      await expect(trigger(consumer, [fullWithdrawal(0)])).to.emit(gateway, "WithdrawalsTriggered");
    });

    it("lets a max partial withdrawal through once enough quota is restored", async () => {
      const framesForMaxPwr = MAX_PWR_AMOUNT_GWEI / PWR.limitPerFrame;
      await advanceChainTime((framesForMaxPwr - 1n) * FRAME);

      await expect(trigger(consumer, [partialWithdrawal(0, MAX_PWR_AMOUNT_GWEI)]))
        .to.be.revertedWithCustomError(gateway, "PwrLimitExceeded")
        .withArgs(MAX_PWR_AMOUNT_GWEI, (framesForMaxPwr - 1n) * PWR.limitPerFrame);

      await advanceChainTime(FRAME);

      await expect(trigger(consumer, [partialWithdrawal(0, MAX_PWR_AMOUNT_GWEI)])).to.emit(
        gateway,
        "WithdrawalsTriggered",
      );
    });
  });
});
