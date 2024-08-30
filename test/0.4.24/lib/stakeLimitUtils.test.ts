import { expect } from "chai";
import { ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { mineUpTo } from "@nomicfoundation/hardhat-network-helpers";
import { latestBlock } from "@nomicfoundation/hardhat-network-helpers/dist/src/helpers/time";

import { StakeLimitUnstructuredStorage__Harness, StakeLimitUtils__Harness } from "typechain-types";

import { Snapshot } from "test/suite";

describe("StakeLimitUtils.sol", () => {
  let stakeLimitUnstructuredStorage: StakeLimitUnstructuredStorage__Harness;
  let stakeLimitUtils: StakeLimitUtils__Harness;

  let originalState: string;

  before(async () => {
    stakeLimitUnstructuredStorage = await ethers.deployContract("StakeLimitUnstructuredStorage__Harness");
    stakeLimitUtils = await ethers.deployContract("StakeLimitUtils__Harness");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("StakeLimitUnstructuredStorage", () => {
    context("setStorageStakeLimitStruct", () => {
      it("Min possible values", async () => {
        const tx: ContractTransactionResponse = await stakeLimitUnstructuredStorage.setStorageStakeLimit(
          0n,
          0n,
          0n,
          0n,
        );
        await expect(tx).to.emit(stakeLimitUnstructuredStorage, "DataSet").withArgs(0n, 0n, 0n, 0n);

        const verifyValues = await stakeLimitUnstructuredStorage.harness__getStorageStakeLimit();
        expect(verifyValues.prevStakeBlockNumber).to.equal(0n);
        expect(verifyValues.prevStakeLimit).to.equal(0n);
        expect(verifyValues.maxStakeLimitGrowthBlocks).to.equal(0n);
        expect(verifyValues.maxStakeLimit).to.equal(0n);
      });

      it("Max possible values", async () => {
        const MAX_UINT32: bigint = 2n ** 32n - 1n;
        const MAX_UINT96: bigint = 2n ** 96n - 1n;

        const tx: ContractTransactionResponse = await stakeLimitUnstructuredStorage.setStorageStakeLimit(
          MAX_UINT32,
          MAX_UINT96,
          MAX_UINT32,
          MAX_UINT96,
        );
        await expect(tx)
          .to.emit(stakeLimitUnstructuredStorage, "DataSet")
          .withArgs(MAX_UINT32, MAX_UINT96, MAX_UINT32, MAX_UINT96);

        const verifyValues = await stakeLimitUnstructuredStorage.harness__getStorageStakeLimit();
        expect(verifyValues.prevStakeBlockNumber).to.equal(MAX_UINT32);
        expect(verifyValues.prevStakeLimit).to.equal(MAX_UINT96);
        expect(verifyValues.maxStakeLimitGrowthBlocks).to.equal(MAX_UINT32);
        expect(verifyValues.maxStakeLimit).to.equal(MAX_UINT96);
      });

      it("Arbitrary valid values", async () => {
        const prevStakeBlockNumber: bigint = 19698885n;
        const prevStakeLimit: bigint = 12345n * 10n ** 18n;
        const maxStakeLimitGrowthBlocks: bigint = 6789n;
        const maxStakeLimit: bigint = 902134n * 10n ** 18n;

        const tx: ContractTransactionResponse = await stakeLimitUnstructuredStorage.setStorageStakeLimit(
          prevStakeBlockNumber,
          prevStakeLimit,
          maxStakeLimitGrowthBlocks,
          maxStakeLimit,
        );
        await expect(tx)
          .to.emit(stakeLimitUnstructuredStorage, "DataSet")
          .withArgs(prevStakeBlockNumber, prevStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);

        const verifyValues = await stakeLimitUnstructuredStorage.harness__getStorageStakeLimit();
        expect(verifyValues.prevStakeBlockNumber).to.equal(prevStakeBlockNumber);
        expect(verifyValues.prevStakeLimit).to.equal(prevStakeLimit);
        expect(verifyValues.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
        expect(verifyValues.maxStakeLimit).to.equal(maxStakeLimit);
      });
    });

    context("getStorageStakeLimitStruct", () => {
      it("Min possible values", async () => {
        const tx: ContractTransactionResponse = await stakeLimitUnstructuredStorage.harness__setStorageStakeLimit(
          0n,
          0n,
          0n,
          0n,
        );
        await expect(tx).to.emit(stakeLimitUnstructuredStorage, "DataSet").withArgs(0n, 0n, 0n, 0n);

        const values = await stakeLimitUnstructuredStorage.getStorageStakeLimit();
        expect(values.prevStakeBlockNumber).to.equal(0n);
        expect(values.prevStakeLimit).to.equal(0n);
        expect(values.maxStakeLimitGrowthBlocks).to.equal(0n);
        expect(values.maxStakeLimit).to.equal(0n);

        const verifyValues = await stakeLimitUnstructuredStorage.harness__getStorageStakeLimit();
        expect(verifyValues.prevStakeBlockNumber).to.equal(0n);
        expect(verifyValues.prevStakeLimit).to.equal(0n);
        expect(verifyValues.maxStakeLimitGrowthBlocks).to.equal(0n);
        expect(verifyValues.maxStakeLimit).to.equal(0n);
      });

      it("Max possible values", async () => {
        const MAX_UINT32: bigint = 2n ** 32n - 1n;
        const MAX_UINT96: bigint = 2n ** 96n - 1n;

        const tx: ContractTransactionResponse = await stakeLimitUnstructuredStorage.harness__setStorageStakeLimit(
          MAX_UINT32,
          MAX_UINT96,
          MAX_UINT32,
          MAX_UINT96,
        );
        await expect(tx)
          .to.emit(stakeLimitUnstructuredStorage, "DataSet")
          .withArgs(MAX_UINT32, MAX_UINT96, MAX_UINT32, MAX_UINT96);

        const values = await stakeLimitUnstructuredStorage.getStorageStakeLimit();
        expect(values.prevStakeBlockNumber).to.equal(MAX_UINT32);
        expect(values.prevStakeLimit).to.equal(MAX_UINT96);
        expect(values.maxStakeLimitGrowthBlocks).to.equal(MAX_UINT32);
        expect(values.maxStakeLimit).to.equal(MAX_UINT96);

        const verifyValues = await stakeLimitUnstructuredStorage.harness__getStorageStakeLimit();
        expect(verifyValues.prevStakeBlockNumber).to.equal(MAX_UINT32);
        expect(verifyValues.prevStakeLimit).to.equal(MAX_UINT96);
        expect(verifyValues.maxStakeLimitGrowthBlocks).to.equal(MAX_UINT32);
        expect(verifyValues.maxStakeLimit).to.equal(MAX_UINT96);
      });

      it("Arbitrary valid values", async () => {
        const prevStakeBlockNumber: bigint = 18787654n;
        const prevStakeLimit: bigint = 23451n * 10n ** 18n;
        const maxStakeLimitGrowthBlocks: bigint = 7896n;
        const maxStakeLimit: bigint = 209431n * 10n ** 18n;

        const tx: ContractTransactionResponse = await stakeLimitUnstructuredStorage.harness__setStorageStakeLimit(
          prevStakeBlockNumber,
          prevStakeLimit,
          maxStakeLimitGrowthBlocks,
          maxStakeLimit,
        );
        await expect(tx)
          .to.emit(stakeLimitUnstructuredStorage, "DataSet")
          .withArgs(prevStakeBlockNumber, prevStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);

        const values = await stakeLimitUnstructuredStorage.getStorageStakeLimit();
        expect(values.prevStakeBlockNumber).to.equal(prevStakeBlockNumber);
        expect(values.prevStakeLimit).to.equal(prevStakeLimit);
        expect(values.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
        expect(values.maxStakeLimit).to.equal(maxStakeLimit);

        const verifyValues = await stakeLimitUnstructuredStorage.harness__getStorageStakeLimit();
        expect(verifyValues.prevStakeBlockNumber).to.equal(prevStakeBlockNumber);
        expect(verifyValues.prevStakeLimit).to.equal(prevStakeLimit);
        expect(verifyValues.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
        expect(verifyValues.maxStakeLimit).to.equal(maxStakeLimit);
      });
    });
  });

  context("StakeLimitUtils", () => {
    let prevStakeBlockNumber = 0n;
    const prevStakeLimit = 10n * 10n ** 18n;
    const maxStakeLimit = 24n * 10n ** 18n;
    const maxStakeLimitGrowthBlocks = 91n;

    beforeEach(async () => {
      prevStakeBlockNumber = BigInt(await latestBlock());

      await expect(
        stakeLimitUtils.harness_setState(
          prevStakeBlockNumber,
          prevStakeLimit,
          maxStakeLimitGrowthBlocks,
          maxStakeLimit,
        ),
      )
        .to.emit(stakeLimitUtils, "DataSet")
        .withArgs(prevStakeBlockNumber, prevStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);
    });

    context("calculate", () => {
      it("zero state results in zero limit", async () => {
        await stakeLimitUtils.harness_setState(0n, 0n, 0n, 0n);

        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(0n);
      });

      it("zero block increment results in static limit", async () => {
        const staticStakeLimit = 1000n * 10n ** 18n;
        const prevStakeBlockNumber1 = 10000n;

        await stakeLimitUtils.harness_setState(prevStakeBlockNumber1, staticStakeLimit, 0n, staticStakeLimit);
        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(staticStakeLimit);

        const prevStakeBlockNumber2 = 11000n;
        await stakeLimitUtils.harness_setState(prevStakeBlockNumber2, staticStakeLimit, 0n, staticStakeLimit);
        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(staticStakeLimit);

        await mineUpTo(123n + BigInt(await latestBlock()));
        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(staticStakeLimit);
      });

      it("the full limit gets restored after growth blocks", async () => {
        prevStakeBlockNumber = BigInt(await latestBlock());
        const baseStakeLimit = 0n;
        await stakeLimitUtils.harness_setState(prevStakeBlockNumber, 0n, maxStakeLimitGrowthBlocks, maxStakeLimit);
        // 1 block passed due to the setter call above
        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(maxStakeLimit / maxStakeLimitGrowthBlocks);

        // growth blocks passed (might be not equal to maxStakeLimit yet due to rounding)
        await mineUpTo(BigInt(prevStakeBlockNumber) + maxStakeLimitGrowthBlocks);
        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(
          baseStakeLimit + maxStakeLimitGrowthBlocks * (maxStakeLimit / maxStakeLimitGrowthBlocks),
        );

        // move forward one more block to account for rounding and reach max
        await mineUpTo(BigInt(prevStakeBlockNumber) + maxStakeLimitGrowthBlocks + 1n);
        // growth blocks mined, the limit should be full
        expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(maxStakeLimit);
      });

      it("the whole limit can be consumed", async () => {
        await stakeLimitUtils.harness_setState(
          prevStakeBlockNumber,
          maxStakeLimit,
          maxStakeLimitGrowthBlocks,
          maxStakeLimit,
        );

        for (let i = 0n; i < maxStakeLimitGrowthBlocks; ++i) {
          const blockNumber = await latestBlock();
          const curPrevStakeLimit = maxStakeLimit - ((i + 1n) * maxStakeLimit) / maxStakeLimitGrowthBlocks;

          await stakeLimitUtils.harness_setState(
            blockNumber,
            curPrevStakeLimit,
            maxStakeLimitGrowthBlocks,
            maxStakeLimit,
          );

          expect(await stakeLimitUtils.calculateCurrentStakeLimit()).to.equal(
            curPrevStakeLimit + maxStakeLimit / maxStakeLimitGrowthBlocks,
          );
        }
      });
    });

    context("pause", () => {
      it("pause is encoded with zero prev stake block number", async () => {
        await stakeLimitUtils.harness_setState(0n, prevStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);

        expect(await stakeLimitUtils.isStakingPaused()).to.be.true;

        await stakeLimitUtils.harness_setState(1n, prevStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);

        expect(await stakeLimitUtils.isStakingPaused()).to.be.false;
      });

      it("pause/unpause works", async () => {
        expect(await stakeLimitUtils.isStakingPaused()).to.be.false;

        await expect(stakeLimitUtils.setStakeLimitPauseState(true))
          .to.emit(stakeLimitUtils, "StakeLimitPauseStateSet")
          .withArgs(true);
        expect(await stakeLimitUtils.isStakingPaused()).to.be.true;

        await expect(stakeLimitUtils.setStakeLimitPauseState(false))
          .to.emit(stakeLimitUtils, "StakeLimitPauseStateSet")
          .withArgs(false);
        expect(await stakeLimitUtils.isStakingPaused()).to.be.false;
      });
    });

    context("set", () => {
      it("reverts on bad input", async () => {
        await expect(stakeLimitUtils.setStakingLimit(0n, 1n)).to.be.revertedWith("ZERO_MAX_STAKE_LIMIT");
        await expect(stakeLimitUtils.setStakingLimit(2n ** 96n, 1n)).to.be.revertedWith("TOO_LARGE_MAX_STAKE_LIMIT");
        await expect(stakeLimitUtils.setStakingLimit(99n, 100n)).to.be.revertedWith("TOO_LARGE_LIMIT_INCREASE");
        await expect(stakeLimitUtils.setStakingLimit(2n ** 32n, 1n)).to.be.revertedWith("TOO_SMALL_LIMIT_INCREASE");
      });

      context("reset prev stake limit cases", () => {
        it("staking was paused", async () => {
          const baseStakeBlockNumber = 0n; // staking is paused
          await stakeLimitUtils.harness_setState(
            baseStakeBlockNumber,
            prevStakeLimit,
            maxStakeLimitGrowthBlocks,
            maxStakeLimit,
          );
          const stakeLimitIncreasePerBlock = maxStakeLimit / maxStakeLimitGrowthBlocks;
          await expect(stakeLimitUtils.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock))
            .to.emit(stakeLimitUtils, "StakingLimitSet")
            .withArgs(maxStakeLimit, stakeLimitIncreasePerBlock);

          const state = await stakeLimitUtils.harness_getState();

          expect(state.prevStakeBlockNumber).to.equal(baseStakeBlockNumber);
          expect(state.maxStakeLimit).to.equal(maxStakeLimit);
          expect(state.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
          // prev stake limit reset
          expect(state.prevStakeLimit).to.equal(maxStakeLimit);
        });

        it("staking was unlimited", async () => {
          const noStakeLimit = 0n; // staking is unlimited
          await stakeLimitUtils.harness_setState(
            prevStakeBlockNumber,
            prevStakeLimit,
            maxStakeLimitGrowthBlocks,
            noStakeLimit,
          );

          const updatedMaxStakeLimit = 10n ** 18n;
          const stakeLimitIncreasePerBlock = updatedMaxStakeLimit / maxStakeLimitGrowthBlocks;
          await expect(stakeLimitUtils.setStakingLimit(updatedMaxStakeLimit, stakeLimitIncreasePerBlock))
            .to.emit(stakeLimitUtils, "StakingLimitSet")
            .withArgs(updatedMaxStakeLimit, stakeLimitIncreasePerBlock);
          const updatedBlock = await latestBlock();

          const state = await stakeLimitUtils.harness_getState();

          expect(state.prevStakeBlockNumber).to.equal(updatedBlock);
          expect(state.maxStakeLimit).to.equal(updatedMaxStakeLimit);
          expect(state.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
          // prev stake limit reset
          expect(state.prevStakeLimit).to.equal(updatedMaxStakeLimit);
        });

        it("new max is lower than the prev stake limit", async () => {
          const updatedMaxStakeLimit = 1n * 10n ** 18n;
          const stakeLimitIncreasePerBlock = updatedMaxStakeLimit / maxStakeLimitGrowthBlocks;
          await expect(stakeLimitUtils.setStakingLimit(updatedMaxStakeLimit, stakeLimitIncreasePerBlock))
            .to.emit(stakeLimitUtils, "StakingLimitSet")
            .withArgs(updatedMaxStakeLimit, stakeLimitIncreasePerBlock);
          const updatedBlock = await latestBlock();

          const state = await stakeLimitUtils.harness_getState();

          expect(state.prevStakeBlockNumber).to.equal(updatedBlock);
          expect(state.maxStakeLimit).to.equal(updatedMaxStakeLimit);
          expect(state.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
          // prev stake limit reset
          expect(state.prevStakeLimit).to.equal(updatedMaxStakeLimit);
        });
      });

      it("can use zero increase", async () => {
        await expect(stakeLimitUtils.setStakingLimit(maxStakeLimit, 0n))
          .to.emit(stakeLimitUtils, "StakingLimitSet")
          .withArgs(maxStakeLimit, 0n);
        const updatedBlock = await latestBlock();

        const state = await stakeLimitUtils.harness_getState();

        expect(state.prevStakeBlockNumber).to.equal(updatedBlock);
        expect(state.prevStakeLimit).to.equal(prevStakeLimit);
        expect(state.maxStakeLimit).to.equal(maxStakeLimit);

        // the growth blocks number is zero
        expect(state.maxStakeLimitGrowthBlocks).to.equal(0n);
      });

      it("same prev stake limit", async () => {
        const stakeLimitIncreasePerBlock = maxStakeLimit / maxStakeLimitGrowthBlocks;
        await expect(stakeLimitUtils.setStakingLimit(maxStakeLimit, stakeLimitIncreasePerBlock))
          .to.emit(stakeLimitUtils, "StakingLimitSet")
          .withArgs(maxStakeLimit, stakeLimitIncreasePerBlock);
        const updatedBlock = await latestBlock();

        const state = await stakeLimitUtils.harness_getState();

        expect(state.prevStakeBlockNumber).to.equal(updatedBlock);
        expect(state.prevStakeLimit).to.equal(prevStakeLimit);
        expect(state.maxStakeLimit).to.equal(maxStakeLimit);
        expect(state.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
      });
    });

    context("remove", () => {
      it("works always", async () => {
        await expect(stakeLimitUtils.removeStakingLimit()).to.emit(stakeLimitUtils, "StakingLimitRemoved");

        const state = await stakeLimitUtils.harness_getState();

        expect(state.prevStakeBlockNumber).to.equal(prevStakeBlockNumber);
        expect(state.prevStakeLimit).to.equal(prevStakeLimit);
        expect(state.maxStakeLimit).to.equal(0n); // unlimited
        expect(state.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
      });
    });

    context("update", () => {
      it("reverts on bad input", async () => {
        await expect(stakeLimitUtils.updatePrevStakeLimit(2n ** 96n)).revertedWithoutReason();

        await stakeLimitUtils.harness_setState(0n, prevStakeLimit, maxStakeLimitGrowthBlocks, maxStakeLimit);
        await expect(stakeLimitUtils.updatePrevStakeLimit(10n)).revertedWithoutReason();
      });

      it("works for regular cases", async () => {
        const updatedValue = 1n * 10n ** 18n;

        await expect(stakeLimitUtils.updatePrevStakeLimit(updatedValue))
          .to.emit(stakeLimitUtils, "PrevStakeLimitUpdated")
          .withArgs(updatedValue);
        const stakeBlockNumber = await latestBlock();

        const state = await stakeLimitUtils.harness_getState();

        expect(state.prevStakeBlockNumber).to.equal(stakeBlockNumber);
        expect(state.prevStakeLimit).to.equal(updatedValue);
        expect(state.maxStakeLimit).to.equal(maxStakeLimit);
        expect(state.maxStakeLimitGrowthBlocks).to.equal(maxStakeLimitGrowthBlocks);
      });
    });

    context("const gas min", () => {
      it("behaves like `min`", async () => {
        expect(await stakeLimitUtils.constGasMin(0n, 0n)).to.equal(0n);
        expect(await stakeLimitUtils.constGasMin(0n, 2n ** 256n - 1n)).to.equal(0n);
        expect(await stakeLimitUtils.constGasMin(2n ** 256n - 1n, 0n)).to.equal(0n);
        expect(await stakeLimitUtils.constGasMin(10n, 1000n)).to.equal(10n);
        expect(await stakeLimitUtils.constGasMin(1000n, 10n)).to.equal(10n);
      });
    });
  });
});
