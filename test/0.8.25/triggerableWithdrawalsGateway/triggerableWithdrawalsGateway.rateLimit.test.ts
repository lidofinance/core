import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { TriggerableWithdrawalsGateway } from "typechain-types";

import { advanceChainTime } from "lib";

import { DEFAULT_TWG_LIMIT, deployTriggerableWithdrawalsGateway } from "test/deploy";
import { Snapshot } from "test/suite";

import { fullWithdrawal, partialWithdrawal } from "../triggerable-withdrawals-helpers";

const GWEI_PER_ETH = 10n ** 9n;

const { maxExitBalanceEth: MAX, balancePerFrameEth: PER_FRAME, frameDurationInSec: FRAME } = DEFAULT_TWG_LIMIT;

describe("TriggerableWithdrawalsGateway.sol: rate limit", () => {
  let gateway: TriggerableWithdrawalsGateway;
  let admin: HardhatEthersSigner;
  let limitManager: HardhatEthersSigner;
  let requester: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [admin, limitManager, requester, stranger] = await ethers.getSigners();

    ({ gateway } = await deployTriggerableWithdrawalsGateway(admin));

    await gateway.connect(admin).grantRole(await gateway.TW_EXIT_LIMIT_MANAGER_ROLE(), limitManager.address);
    await gateway.connect(admin).grantRole(await gateway.ADD_WITHDRAWAL_REQUEST_ROLE(), requester.address);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
    // Re-setting the full limit starts a new frame now: frames are long compared to the few seconds
    // between transactions in a test, so the restored balance below is exact in frames
    await gateway.connect(limitManager).setExitRequestLimit(MAX, PER_FRAME, FRAME);
  });

  afterEach(async () => await Snapshot.restore(originalState));

  const currentLimit = async () => (await gateway.getExitRequestLimitFullInfo()).currentExitBalanceEth;

  /** Consumes exactly `weightEth` of the limit with partial withdrawals of whole ETH. */
  const consume = async (weightEth: bigint) => {
    const intents = [];
    for (let left = weightEth, i = 0; left > 0n; ++i) {
      const chunk = left > 2048n ? 2048n : left;
      intents.push(partialWithdrawal(i, chunk * GWEI_PER_ETH));
      left -= chunk;
    }
    await gateway.connect(requester).triggerWithdrawals(intents, requester.address, { value: BigInt(intents.length) });
  };

  context("setExitRequestLimit", () => {
    it("reverts if caller has no TW_EXIT_LIMIT_MANAGER_ROLE", async () => {
      await expect(gateway.connect(stranger).setExitRequestLimit(4096, 64, 12))
        .to.be.revertedWithCustomError(gateway, "AccessControlUnauthorizedAccount")
        .withArgs(stranger.address, await gateway.TW_EXIT_LIMIT_MANAGER_ROLE());
    });

    it("sets the limit and emits ExitBalanceLimitSet", async () => {
      await expect(gateway.connect(limitManager).setExitRequestLimit(4096, 64, 12))
        .to.emit(gateway, "ExitBalanceLimitSet")
        .withArgs(4096, 64, 12);

      const info = await gateway.getExitRequestLimitFullInfo();
      expect(info.maxExitBalanceEth).to.equal(4096);
      expect(info.balancePerFrameEth).to.equal(64);
      expect(info.frameDurationInSec).to.equal(12);
      expect(info.currentExitBalanceEth).to.equal(4096);
    });

    it("reverts if max exit balance is below the full withdrawal weight", async () => {
      await expect(gateway.connect(limitManager).setExitRequestLimit(2047, 1, 12))
        .to.be.revertedWithCustomError(gateway, "TooSmallMaxExitBalance")
        .withArgs(2047);
    });

    it("reverts if balance per frame is zero", async () => {
      await expect(gateway.connect(limitManager).setExitRequestLimit(2048, 0, 12))
        .to.be.revertedWithCustomError(gateway, "ZeroArgument")
        .withArgs("balancePerFrameEth");
    });

    it("reverts if balance per frame exceeds the max exit balance", async () => {
      await expect(gateway.connect(limitManager).setExitRequestLimit(2048, 2049, 12)).to.be.revertedWithCustomError(
        gateway,
        "TooLargeItemsPerFrame",
      );
    });

    it("reverts if frame duration is zero", async () => {
      await expect(gateway.connect(limitManager).setExitRequestLimit(2048, 1, 0)).to.be.revertedWithCustomError(
        gateway,
        "ZeroFrameDuration",
      );
    });

    it("keeps the balance restored since the last request", async () => {
      await consume(MAX);
      await advanceChainTime(3n * FRAME);
      expect(await currentLimit()).to.equal(3n * PER_FRAME);

      await gateway.connect(limitManager).setExitRequestLimit(MAX, PER_FRAME, FRAME);

      expect(await currentLimit()).to.equal(3n * PER_FRAME);
    });

    it("caps the current limit by a lower max exit balance", async () => {
      await consume(1000n);

      await gateway.connect(limitManager).setExitRequestLimit(4096, PER_FRAME, FRAME);

      expect(await currentLimit()).to.equal(4096);
    });

    it("does not increase the current limit when the max exit balance grows", async () => {
      await consume(1000n);

      await gateway.connect(limitManager).setExitRequestLimit(MAX * 2n, PER_FRAME, FRAME);

      expect(await currentLimit()).to.equal(MAX - 1000n);
    });
  });

  context("consumption", () => {
    it("allows a batch that exactly exhausts the limit", async () => {
      await consume(MAX);

      expect(await currentLimit()).to.equal(0);
    });

    it("reverts the whole batch if it exceeds the remaining limit", async () => {
      await consume(MAX - 2047n);

      await expect(
        gateway
          .connect(requester)
          .triggerWithdrawals([partialWithdrawal(0, GWEI_PER_ETH), fullWithdrawal(1)], requester.address, {
            value: 2n,
          }),
      )
        .to.be.revertedWithCustomError(gateway, "ExitRequestsLimitExceeded")
        .withArgs(2049, 2047);

      expect(await currentLimit()).to.equal(2047);
    });
  });

  context("restoration", () => {
    beforeEach(async () => {
      await consume(MAX);
    });

    it("does not restore the limit within a frame", async () => {
      await advanceChainTime(FRAME / 2n);

      expect(await currentLimit()).to.equal(0);
    });

    it("restores the balance per frame for each passed frame", async () => {
      await advanceChainTime(5n * FRAME);

      expect(await currentLimit()).to.equal(5n * PER_FRAME);
    });

    it("caps the restored limit by the max exit balance", async () => {
      await advanceChainTime((MAX / PER_FRAME + 10n) * FRAME);

      expect(await currentLimit()).to.equal(MAX);
    });

    it("lets a full withdrawal through once enough balance is restored", async () => {
      const framesForFullWithdrawal = 2048n / PER_FRAME;
      await advanceChainTime((framesForFullWithdrawal - 1n) * FRAME);

      await expect(
        gateway.connect(requester).triggerWithdrawals([fullWithdrawal(0)], requester.address, { value: 1n }),
      ).to.be.revertedWithCustomError(gateway, "ExitRequestsLimitExceeded");

      await advanceChainTime(FRAME);

      await expect(
        gateway.connect(requester).triggerWithdrawals([fullWithdrawal(0)], requester.address, { value: 1n }),
      ).to.emit(gateway, "WithdrawalsTriggered");
    });
  });
});
