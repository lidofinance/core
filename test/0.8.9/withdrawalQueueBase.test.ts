import { expect } from "chai";
import { parseUnits, Result } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import { Receiver__MockForWithdrawalQueueBase, WithdrawalsQueueBase__Harness } from "typechain-types";

import { ether, shareRate, shares, WITHDRAWAL_MAX_BATCHES_LENGTH } from "lib";

import { Snapshot } from "test/suite";

const buildBatchCalculationState = (...args: unknown[]) => ({
  remainingEthBudget: args[0] as bigint,
  finished: args[1] as boolean,
  batches: args[2] as number[],
  batchesLength: args[3] as number,
});

const MAX_BATCHES = Number(WITHDRAWAL_MAX_BATCHES_LENGTH);

describe("WithdrawalQueueBase.sol", () => {
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let queue: WithdrawalsQueueBase__Harness;
  let queueAddress: string;
  let receiver: Receiver__MockForWithdrawalQueueBase;

  let originalState: string;
  let provider: typeof ethers.provider;

  // Required for _findCheckpointHint, _calculateClaimableEther, _calcBatch tests
  const setUpRequestsState = async (requestsCount: number, finalizedCount: number) => {
    for (let i = 0; i < requestsCount; i++) {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      if (i < finalizedCount) {
        await queue.harness__finalize(i + 1, ether("1.00"), shareRate(1n));
      }
    }
  };

  // Runs `calculateFinalizationBatches` until the state is finished, the way the oracle daemon does
  const calculateBatches = async (maxShareRate: bigint, budget: bigint, maxRequestsPerCall: number) => {
    let state = buildBatchCalculationState(budget, false, Array(MAX_BATCHES).fill(0n), 0);
    do {
      const calc = await queue.calculateFinalizationBatches(maxShareRate, 10000000000, maxRequestsPerCall, state);
      state = buildBatchCalculationState(
        calc.remainingEthBudget,
        calc.finished,
        (calc.batches as Result).toArray(),
        calc.batchesLength,
      );
    } while (!state.finished);

    return {
      remainingEthBudget: state.remainingEthBudget,
      finished: state.finished,
      batchesLength: Number(state.batchesLength),
      batches: (state.batches as unknown as bigint[]).slice(0, Number(state.batchesLength)),
    };
  };

  before(async () => {
    ({ provider } = ethers);
    [owner, stranger] = await ethers.getSigners();

    receiver = await ethers.deployContract("Receiver__MockForWithdrawalQueueBase");

    queue = await ethers.deployContract("WithdrawalsQueueBase__Harness");

    queueAddress = await queue.getAddress();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("Returns the MAX_BATCHES_LENGTH variable", async () => {
      expect(await queue.MAX_BATCHES_LENGTH()).to.equal(WITHDRAWAL_MAX_BATCHES_LENGTH);
    });
  });

  context("getLastRequestId", () => {
    it("Returns 0 if no requests in the queue", async () => {
      expect(await queue.getLastRequestId()).to.equal(0);
    });

    it("Returns the last request id in case queue is not empty", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      expect(await queue.getLastRequestId()).to.equal(1);
    });
  });

  context("getLastFinalizedRequestId", () => {
    it("Returns 0 if no requests in the queue", async () => {
      expect(await queue.getLastFinalizedRequestId()).to.equal(0);
    });

    it("Returns the last finalized request id in case queue is not empty", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      expect(await queue.getLastFinalizedRequestId()).to.equal(1);
    });
  });

  context("getLockedEtherAmount", () => {
    it("Returns 0 if no requests in the queue", async () => {
      expect(await queue.getLockedEtherAmount()).to.equal(0);
    });

    it("Returns the locked ether amount in case queue is not empty", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      expect(await queue.getLockedEtherAmount()).to.equal(ether("1.00"));
    });
  });

  context("getLastCheckpointIndex", () => {
    it("Returns 0 if no requests in the queue", async () => {
      expect(await queue.getLastCheckpointIndex()).to.equal(0);
    });

    it("Returns the last checkpoint index in case queue is not empty", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      expect(await queue.getLastCheckpointIndex()).to.equal(1);
    });
  });

  context("unfinalizedRequestNumber", () => {
    it("Returns 0 if no requests in the queue", async () => {
      expect(await queue.unfinalizedRequestNumber()).to.equal(0);
    });

    it("Returns the number of unfinalized requests in case queue is not empty", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("2.00"), shares(2n), owner);

      expect(await queue.unfinalizedRequestNumber()).to.equal(2);
    });
  });

  context("unfinalizedStETH", () => {
    it("Returns 0 if no requests in the queue", async () => {
      expect(await queue.unfinalizedStETH()).to.equal(0);
    });

    it("Returns the amount of unfinalized stETH in case queue is not empty", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("2.00"), shares(2n), owner);

      expect(await queue.unfinalizedStETH()).to.equal(shares(3n));
    });
  });

  context("calculateFinalizationBatches", () => {
    it("Reverts on invalid state", async () => {
      await expect(
        queue.calculateFinalizationBatches(
          shareRate(300n),
          100000,
          1000,
          buildBatchCalculationState(ether("10.00"), true, Array(MAX_BATCHES).fill(0n), 0),
        ),
      ).to.be.revertedWithCustomError(queue, "InvalidState");
    });

    it("Does not revert on zero budget", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const calc = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1000,
        buildBatchCalculationState(0n, false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc.remainingEthBudget).to.equal(0);
      expect(calc.finished).to.equal(true);
      expect(calc.batchesLength).to.equal(0);
    });

    it("Continues the calculation after a call that spent the whole budget", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const calc1 = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(ether("1.00"), false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc1.remainingEthBudget).to.equal(0);
      expect(calc1.finished).to.equal(false);

      const calc2 = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(
          calc1.remainingEthBudget,
          calc1.finished,
          (calc1.batches as Result).toArray(),
          calc1.batchesLength,
        ),
      );

      expect(calc2.remainingEthBudget).to.equal(0);
      expect(calc2.finished).to.equal(true);
      expect(calc2.batches[0]).to.equal(1);
      expect(calc2.batchesLength).to.equal(1);
    });

    it("Stops on max timestamp", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const timestamp = await time.latest();

      const calc = await queue.calculateFinalizationBatches(
        shareRate(1n),
        timestamp - 1,
        1,
        buildBatchCalculationState(ether("2.00"), false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc.finished).to.equal(true, "calc->finished");
      expect(calc.batchesLength).to.equal(0, "calc->batchesLength");
    });

    it("Works correctly on multiple calls", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const calc1 = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(ether("2.00"), false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc1.remainingEthBudget).to.equal(ether("1.00"), "calc1->remainingEthBudget");
      expect(calc1.finished).to.equal(false, "calc1->finished");
      expect(calc1.batches[0]).to.equal(1, "calc1->batches[0]");
      expect(calc1.batchesLength).to.equal(1, "calc1->batchesLength");

      const calc2 = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(
          calc1.remainingEthBudget,
          calc1.finished,
          (calc1.batches as Result).toArray(),
          calc1.batchesLength,
        ),
      );

      expect(calc2.remainingEthBudget).to.equal(0, "calc2->remainingEthBudget");
      expect(calc2.finished).to.equal(true, "calc2->finished");
      expect(calc2.batches[0]).to.equal(2, "calc2->batches[0]");
      expect(calc2.batchesLength).to.equal(1, "calc2->batchesLength");
    });

    it("Works correctly on multiple calls with multiple batches for discounts", async () => {
      await queue.harness__enqueue(ether("2.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const calc1 = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(ether("2.00"), false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc1.remainingEthBudget).to.equal(ether("1.00"), "calc1->remainingEthBudget");
      expect(calc1.finished).to.equal(false, "calc1->finished");
      expect(calc1.batches[0]).to.equal(1, "calc1->batches[0]");
      expect(calc1.batchesLength).to.equal(1, "calc1->batchesLength");

      const calc2 = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(
          calc1.remainingEthBudget,
          calc1.finished,
          (calc1.batches as Result).toArray(),
          calc1.batchesLength,
        ),
      );

      expect(calc2.remainingEthBudget).to.equal(0, "calc2->remainingEthBudget");
      expect(calc2.finished).to.equal(true, "calc2->finished");
      expect(calc2.batches[0]).to.equal(2, "calc2->batches[0]");
      expect(calc2.batchesLength).to.equal(1, "calc2->batchesLength");
    });

    it("Splits requests above max share rate in different reports into separate batches", async () => {
      const maxShareRate = parseUnits("1", 26); // 0.1

      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__setLastReportTimestamp(await time.latest());

      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__setLastReportTimestamp(await time.latest());

      const calc1 = await queue.calculateFinalizationBatches(
        maxShareRate,
        10000000000,
        1,
        buildBatchCalculationState(ether("20.00"), false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc1.remainingEthBudget).to.equal(ether("19.90"), "calc1->remainingEthBudget");
      expect(calc1.finished).to.equal(false, "calc1->finished");
      expect(calc1.batches[0]).to.equal(1, "calc1->batches[0]");
      expect(calc1.batchesLength).to.equal(1, "calc1->batchesLength");

      const calc2 = await queue.calculateFinalizationBatches(
        maxShareRate,
        10000000000,
        1,
        buildBatchCalculationState(
          calc1.remainingEthBudget,
          calc1.finished,
          (calc1.batches as Result).toArray(),
          calc1.batchesLength,
        ),
      );

      expect(calc2.remainingEthBudget).to.equal(ether("19.80"), "calc2->remainingEthBudget");
      expect(calc2.finished).to.equal(true, "calc2->finished");
      expect(calc2.batches[0]).to.equal(1, "calc2->batches[0]");
      expect(calc2.batches[1]).to.equal(2, "calc2->batches[1]");
      expect(calc2.batchesLength).to.equal(2, "calc2->batchesLength");
    });

    it("Splits requests below max share rate in different reports into separate batches", async () => {
      const maxShareRate = shareRate(1n);

      await queue.harness__enqueue(ether("10.00"), shares(500n), owner);
      await queue.harness__setLastReportTimestamp(await time.latest());

      await queue.harness__enqueue(ether("10.00"), shares(500n), owner);
      await queue.harness__setLastReportTimestamp(await time.latest());

      const calc1 = await queue.calculateFinalizationBatches(
        maxShareRate,
        10000000000,
        1,
        buildBatchCalculationState(ether("20.00"), false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc1.remainingEthBudget).to.equal(ether("10.00"), "calc1->remainingEthBudget");
      expect(calc1.finished).to.equal(false, "calc1->finished");
      expect(calc1.batches[0]).to.equal(1, "calc1->batches[0]");
      expect(calc1.batchesLength).to.equal(1, "calc1->batchesLength");

      const calc2 = await queue.calculateFinalizationBatches(
        maxShareRate,
        10000000000,
        1,
        buildBatchCalculationState(
          calc1.remainingEthBudget,
          calc1.finished,
          (calc1.batches as Result).toArray(),
          calc1.batchesLength,
        ),
      );

      expect(calc2.remainingEthBudget).to.equal(ether("0.00"), "calc2->remainingEthBudget");
      expect(calc2.finished).to.equal(true, "calc2->finished");
      expect(calc2.batches[0]).to.equal(1, "calc2->batches[0]");
      expect(calc2.batches[1]).to.equal(2, "calc2->batches[1]");
      expect(calc2.batchesLength).to.equal(2, "calc2->batchesLength");
    });

    it("Works for budget break", async () => {
      const budget = ether("0.50");

      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const calc = await queue.calculateFinalizationBatches(
        shareRate(1n),
        10000000000,
        1,
        buildBatchCalculationState(budget, false, Array(MAX_BATCHES).fill(0n), 0),
      );

      expect(calc.remainingEthBudget).to.equal(budget);
      expect(calc.finished).to.equal(true);
      expect(calc.batchesLength).to.equal(0);
    });

    it("Works for on-chain batch limiter", async () => {
      for (let i = 0; i <= MAX_BATCHES; i++) {
        await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
        await queue.harness__setLastReportTimestamp(i + 1);
      }

      const calc = await calculateBatches(shareRate(1n), ether("100.00"), 1000);

      expect(calc.batchesLength).to.equal(MAX_BATCHES);
      expect(calc.batches).to.deep.equal(Array.from({ length: MAX_BATCHES }, (_, i) => BigInt(i + 1)));
      expect(calc.finished).to.equal(true);
      // the request that has no batch left is not charged
      expect(calc.remainingEthBudget).to.equal(ether("100.00") - ether("1.00") * BigInt(MAX_BATCHES));
    });

    context("Budget matches prefinalize", () => {
      // share rate of 1.2738 with which the requests are placed
      const placeRequest = (stETH: bigint) => queue.harness__enqueue(stETH, (stETH * 10000n) / 12738n, owner);

      const expectBudgetToMatchPrefinalize = async (maxShareRate: bigint, budget: bigint) => {
        const calc = await calculateBatches(maxShareRate, budget, 1000);
        // a paged calculation must give the same result
        const pagedCalc = await calculateBatches(maxShareRate, budget, 1);
        expect(pagedCalc.batches).to.deep.equal(calc.batches);
        expect(pagedCalc.remainingEthBudget).to.equal(calc.remainingEthBudget);

        const [ethToLock] = await queue.prefinalize(calc.batches, maxShareRate);
        expect(ethToLock).to.equal(budget - calc.remainingEthBudget);

        return { ...calc, ethToLock };
      };

      it("Charges the budget with the batch price for dust requests in a nominal batch", async () => {
        const maxShareRate = parseUnits("1.274", 27);
        // 100 wei requests get 78 shares, so their own share rate is above the max share rate
        for (let i = 0; i < 4; i++) await placeRequest(100n);
        await placeRequest(ether("19.00"));

        // the budget that covers each request at its own price: 4 * 99 wei + 19 ETH
        const { batches, ethToLock } = await expectBudgetToMatchPrefinalize(maxShareRate, ether("19.00") + 396n);
        expect(batches).to.deep.equal([4n]);
        expect(ethToLock).to.equal(397n);

        const full = await expectBudgetToMatchPrefinalize(maxShareRate, ether("19.00") + 400n);
        expect(full.batches).to.deep.equal([5n]);
        expect(full.remainingEthBudget).to.equal(0n);
      });

      it("Charges the budget with the batch price after already finalized requests", async () => {
        const maxShareRate = parseUnits("1.274", 27);
        await placeRequest(ether("5.00"));
        await queue.harness__finalize(1, ether("5.00"), maxShareRate);

        for (let i = 0; i < 4; i++) await placeRequest(100n);
        await placeRequest(ether("19.00"));

        // the paged calculation resumes the first batch, which starts after the last finalized request
        const { batches, ethToLock } = await expectBudgetToMatchPrefinalize(maxShareRate, ether("19.00") + 396n);
        expect(batches).to.deep.equal([5n]);
        expect(ethToLock).to.equal(397n);

        await expectBudgetToMatchPrefinalize(maxShareRate, ether("19.00") + 400n);
      });

      it("Charges the budget with the batch price for a discounted batch", async () => {
        const maxShareRate = parseUnits("1.26", 27);
        for (let i = 1n; i <= 40n; i++) await placeRequest(ether("1.00") * i + i * 7919n);

        const [fullPrice] = await queue.prefinalize([40n], maxShareRate);
        const { batches, remainingEthBudget } = await expectBudgetToMatchPrefinalize(maxShareRate, fullPrice);
        expect(batches).to.deep.equal([40n]);
        expect(remainingEthBudget).to.equal(0n);

        await expectBudgetToMatchPrefinalize(maxShareRate, fullPrice - 1n);
      });

      it("Charges the budget with the batch prices over several report periods", async () => {
        const maxShareRate = parseUnits("1.274", 27);
        for (let period = 1; period <= 3; period++) {
          for (let i = 0; i < 3; i++) await placeRequest(100n);
          await placeRequest(ether("1.00") * BigInt(period));
          await queue.harness__setLastReportTimestamp(period);
        }

        const [fullPrice] = await queue.prefinalize([4n, 8n, 12n], maxShareRate);
        for (const budget of [fullPrice, fullPrice - 1n, ether("3.00"), ether("1.00")]) {
          await expectBudgetToMatchPrefinalize(maxShareRate, budget);
        }
      });
    });

    context("Batches of report periods", () => {
      const maxShareRate = parseUnits("1.2705", 27);

      const finalizeAndGetExcessLock = async (batches: bigint[]) => {
        const lastId = batches[batches.length - 1];
        const [ethToLock] = await queue.prefinalize(batches, maxShareRate);
        await queue.harness__finalize(lastId, ethToLock, maxShareRate);

        let claimable = 0n;
        for (let id = 1n; id <= lastId; id++) {
          claimable += await queue.harness__calculateClaimableEther(id, 1n);
        }
        return { ethToLock, excess: ethToLock - claimable };
      };

      it("Does not join a discounted report period with a nominal one through a dust request", async () => {
        await queue.harness__enqueue(ether("127.1"), ether("100"), owner); // discounted
        await queue.harness__setLastReportTimestamp(1);
        await queue.harness__enqueue(100n, 78n, owner); // dust, own share rate is above the line
        await queue.harness__enqueue(ether("127"), ether("100"), owner); // nominal

        const { batches } = await calculateBatches(maxShareRate, ether("1000"), 1000);
        expect(batches).to.deep.equal([1n, 3n]);

        const { ethToLock, excess } = await finalizeAndGetExcessLock(batches);
        expect(ethToLock).to.equal(ether("127.05") + ether("127") + 100n);
        // only the rounding of the dust request's claim stays locked
        expect(excess).to.be.lte(1n);
      });

      it("Does not join a nominal report period with a discounted one through a dust request", async () => {
        await queue.harness__enqueue(ether("127"), ether("100"), owner); // nominal
        await queue.harness__enqueue(100n, 78n, owner); // dust, own share rate is above the line
        await queue.harness__setLastReportTimestamp(1);
        await queue.harness__enqueue(ether("127.1"), ether("100"), owner); // discounted

        const { batches } = await calculateBatches(maxShareRate, ether("1000"), 1000);
        expect(batches).to.deep.equal([2n, 3n]);

        const { ethToLock, excess } = await finalizeAndGetExcessLock(batches);
        expect(ethToLock).to.equal(ether("127") + 100n + ether("127.05"));
        expect(excess).to.be.lte(1n);
      });

      it("Keeps the requests of one report period in one batch regardless of their own share rates", async () => {
        await queue.harness__enqueue(ether("127"), ether("100"), owner); // nominal
        await queue.harness__enqueue(100n, 78n, owner); // dust, own share rate is above the line
        await queue.harness__enqueue(ether("127"), ether("100"), owner); // nominal

        const { batches } = await calculateBatches(maxShareRate, ether("1000"), 1);
        expect(batches).to.deep.equal([3n]);
      });
    });
  });

  context("prefinalize", () => {
    it("Reverts if share rate is 0", async () => {
      await expect(queue.prefinalize([1], 0)).to.be.revertedWithCustomError(queue, "ZeroShareRate");
    });

    it("Reverts for zero request id", async () => {
      await expect(queue.prefinalize([0], shareRate(1n)))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(0);
    });

    it("Reverts if batches length is zero", async () => {
      await expect(queue.prefinalize([], shareRate(1n))).to.be.revertedWithCustomError(queue, "EmptyBatches");
    });

    it("Reverts if request id is out of queue bounds", async () => {
      await expect(queue.prefinalize([1], shareRate(1n)))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(1);
    });

    it("Reverts if request id is already finalized", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      await expect(queue.prefinalize([1], shareRate(1n)))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(1);
    });

    it("Reverts if batches are not in ascending order", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("2.00"), shares(2n), owner);

      await expect(queue.prefinalize([2, 1], shareRate(1n))).to.be.revertedWithCustomError(
        queue,
        "BatchesAreNotSorted",
      );
    });

    it("Returns ethToLock and sharesToBurn", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const result = await queue.prefinalize([1], shareRate(1n));

      expect(result.ethToLock).to.equal(ether("1.00"));
      expect(result.sharesToBurn).to.equal(shares(1n));
    });

    it("Returns ethToLock and sharesToBurn for discounted", async () => {
      await queue.harness__enqueue(ether("2.00"), shares(1n), owner);
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const result = await queue.prefinalize([1, 2], shareRate(1n));

      expect(result.ethToLock).to.equal(ether("2.00"));
      expect(result.sharesToBurn).to.equal(shares(2n));
    });
  });

  context("_finalize", () => {
    it("Reverts if request id is out of queue bounds", async () => {
      await expect(queue.harness__finalize(1, ether("1.00"), shareRate(1n)))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(1);
    });

    it("Reverts if request id is already finalized", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      await expect(queue.harness__finalize(1, ether("1.00"), shareRate(1n)))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(1);
    });

    it("Reverts if amount to finalize is greater than the locked amount", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      await expect(queue.harness__finalize(1, ether("2.00"), shareRate(1n)))
        .to.be.revertedWithCustomError(queue, "TooMuchEtherToFinalize")
        .withArgs(ether("2.00"), ether("1.00"));
    });
  });

  context("_enqueue", () => {
    it("Enqueues a new request", async () => {
      await expect(queue.harness__enqueue(ether("1.00"), shares(1n), owner))
        .to.emit(queue, "WithdrawalRequested")
        .withArgs(1, owner.address, owner.address, ether("1.00"), shares(1n));

      expect(await queue.getLastRequestId()).to.equal(1);
    });

    it("Enqueues multiple requests", async () => {
      await expect(queue.harness__enqueue(ether("1.00"), shares(1n), owner))
        .to.emit(queue, "WithdrawalRequested")
        .withArgs(1, owner.address, owner.address, ether("1.00"), shares(1n));

      await expect(queue.harness__enqueue(ether("2.00"), shares(2n), owner))
        .to.emit(queue, "WithdrawalRequested")
        .withArgs(2, owner.address, owner.address, ether("2.00"), shares(2n));

      expect(await queue.getLastRequestId()).to.equal(2);
    });
  });

  context("_getStatus", () => {
    it("Reverts if request id is out of queue bounds", async () => {
      await expect(queue.harness__getStatus(0)).to.be.revertedWithCustomError(queue, "InvalidRequestId").withArgs(0);
    });

    it("Reverts if request out of queue bounds", async () => {
      await expect(queue.harness__getStatus(1)).to.be.revertedWithCustomError(queue, "InvalidRequestId").withArgs(1);
    });

    it("Returns the queue status", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      const timestamp = await time.latest();

      const status = await queue.harness__getStatus(1);

      expect(status.amountOfStETH).to.equal(shares(1n));
      expect(status.amountOfShares).to.equal(shares(1n));
      expect(status.owner).to.equal(owner.address);
      expect(status.timestamp).to.equal(timestamp);
      expect(status.isFinalized).to.equal(false);
      expect(status.isClaimed).to.equal(false);
    });
  });

  context("_findCheckpointHint", () => {
    it("Reverts if request id is 0", async () => {
      await expect(queue.harness__findCheckpointHint(0n, 0n, 1n))
        .to.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(0);
    });

    it("Reverts if request id is out of queue bounds", async () => {
      await expect(queue.harness__findCheckpointHint(1n, 0n, 1n))
        .to.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(1);
    });

    it("Reverts if start index is out of queue bounds", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      await expect(queue.harness__findCheckpointHint(1n, 0n, 1n))
        .to.revertedWithCustomError(queue, "InvalidRequestIdRange")
        .withArgs(0n, 1n);
    });

    it("Reverts if end index is out of queue bounds", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      await expect(queue.harness__findCheckpointHint(1n, 1n, 1000n))
        .to.revertedWithCustomError(queue, "InvalidRequestIdRange")
        .withArgs(1n, 1000n);
    });

    it("Rerurns 0 if last checkpoint id is 0", async () => {
      await setUpRequestsState(1, 0);

      expect(await queue.harness__findCheckpointHint(1n, 1n, 0n)).to.equal(0);
    });

    it("Returns 0 if request id is greater than last finalized request", async () => {
      await queue.harness__setLastCheckpointIndex(1n);
      await setUpRequestsState(2, 1);

      expect(await queue.harness__findCheckpointHint(2n, 1n, 2n)).to.equal(0);
    });

    it("Returns 0 if start request id is greater than end request id", async () => {
      await queue.harness__setLastCheckpointIndex(1n);
      await setUpRequestsState(2, 1);

      expect(await queue.harness__findCheckpointHint(1n, 2n, 1n)).to.equal(0);
    });

    it("Returns right boundary hint for last checkpoint", async () => {
      await setUpRequestsState(1, 1);

      expect(await queue.harness__findCheckpointHint(1n, 1n, 1n)).to.equal(1n);
    });

    it("Returns right boundary hint if request fits right before the next checkpoint", async () => {
      await queue.harness__setLastCheckpointIndex(1n);
      await setUpRequestsState(3, 3);

      expect(await queue.harness__findCheckpointHint(1n, 2n, 2n)).to.equal(2n);
    });

    it("Returns 0 for right boundary hint request can't be fitted", async () => {
      await queue.harness__setLastCheckpointIndex(3n);
      await setUpRequestsState(3, 1);

      expect(await queue.harness__findCheckpointHint(1n, 1n, 3n)).to.equal(0);
    });

    it("Returns left boundary hint for first request", async () => {
      await setUpRequestsState(3, 3);

      expect(await queue.harness__findCheckpointHint(1n, 2n, 3n)).to.equal(0);
    });

    it("Returns binary search results", async () => {
      await setUpRequestsState(3, 3);

      expect(await queue.harness__findCheckpointHint(2n, 1n, 3n)).to.equal(2n);
    });

    it("Returns binary search results", async () => {
      await setUpRequestsState(5, 5);

      expect(await queue.harness__findCheckpointHint(3n, 1n, 5n)).to.equal(3n);
    });
  });

  context("_claim", () => {
    it("Reverts if request id is 0", async () => {
      await expect(queue.harness__claim(0, 1, owner))
        .to.be.revertedWithCustomError(queue, "InvalidRequestId")
        .withArgs(0);
    });

    it("Reverts if request id is out of queue bounds", async () => {
      await expect(queue.harness__claim(1, 1, owner))
        .to.be.revertedWithCustomError(queue, "RequestNotFoundOrNotFinalized")
        .withArgs(1);
    });

    it("Reverts if request is not finalized", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);

      await expect(queue.harness__claim(1, 1, owner))
        .to.be.revertedWithCustomError(queue, "RequestNotFoundOrNotFinalized")
        .withArgs(1);
    });

    it("Reverts if request is already claimed", async () => {
      await setBalance(queueAddress, ether("10.00"));

      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));
      await queue.harness__claim(1, 1, owner);

      await expect(queue.harness__claim(1, 1, owner))
        .to.be.revertedWithCustomError(queue, "RequestAlreadyClaimed")
        .withArgs(1);
    });

    it("Reverts if not enough ether", async () => {
      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      await expect(queue.harness__claim(1, 1, owner)).to.be.revertedWithCustomError(queue, "NotEnoughEther");
    });

    it("Reverts if not owner", async () => {
      await setBalance(queueAddress, ether("10.00"));

      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      await expect(queue.connect(stranger).harness__claim(1, 1, owner))
        .to.be.revertedWithCustomError(queue, "NotOwner")
        .withArgs(stranger.address, owner.address);
    });

    it("Claims the request", async () => {
      await setBalance(queueAddress, ether("10.00"));

      await queue.harness__enqueue(ether("1.00"), shares(1n), owner);
      await queue.prefinalize([1], shareRate(1n));
      await queue.harness__finalize(1, ether("1.00"), shareRate(1n));

      const balanceBefore = await provider.getBalance(stranger);
      const lockedBefore = await queue.getLockedEtherAmount();

      await expect(queue.harness__claim(1, 1, stranger))
        .to.emit(queue, "WithdrawalClaimed")
        .withArgs(1, owner.address, stranger.address, shares(1n));

      const balanceAfter = await provider.getBalance(stranger);
      const lockedAfter = await queue.getLockedEtherAmount();

      expect(balanceAfter - balanceBefore).to.equal(ether("1.00"));
      expect(lockedBefore - lockedAfter).to.equal(ether("1.00"));
    });
  });

  context("_calculateClaimableEther", () => {
    it("Reverts if hint is 0", async () => {
      await expect(queue.harness__calculateClaimableEther(1, 0))
        .to.be.revertedWithCustomError(queue, "InvalidHint")
        .withArgs(0);
    });

    it("Reverts if request id is 0", async () => {
      await expect(queue.harness__calculateClaimableEther(0, 1))
        .to.be.revertedWithCustomError(queue, "InvalidHint")
        .withArgs(1);
    });

    it("Reverts if request id is out of hints range", async () => {
      await setUpRequestsState(3, 3);

      await expect(queue.harness__calculateClaimableEther(1, 3))
        .to.be.revertedWithCustomError(queue, "InvalidHint")
        .withArgs(3);
    });

    it("Reverts if request id is not in hints range", async () => {
      await setUpRequestsState(5, 5);

      await expect(queue.harness__calculateClaimableEther(5, 3))
        .to.be.revertedWithCustomError(queue, "InvalidHint")
        .withArgs(3);
    });

    it("Calculates the claimable ether", async () => {
      await setUpRequestsState(5, 5);

      expect(await queue.harness__calculateClaimableEther(3, 3)).to.equal(ether("1.00"));
    });

    it("Calculates the claimable ether taking share rate into account", async () => {
      await queue.harness__enqueue(ether("2.00"), shares(3n), owner);
      await queue.harness__enqueue(ether("2.00"), shares(2n), owner);
      await queue.harness__enqueue(ether("2.00"), shares(1n), owner);
      await queue.harness__finalize(1, ether("2.00"), shareRate(3n));
      await queue.harness__finalize(2, ether("2.00"), shareRate(2n));
      await queue.harness__finalize(3, ether("2.00"), shareRate(1n));

      expect(await queue.harness__calculateClaimableEther(3, 3)).to.equal(ether("1.00"));
    });
  });

  context("_initializeQueue", () => {
    it("Initializes the queue with default params", async () => {
      await queue.harness__initializeQueue();

      expect(await queue.getLastRequestId()).to.equal(0);
      expect(await queue.getLastFinalizedRequestId()).to.equal(0);
      expect(await queue.getLastCheckpointIndex()).to.equal(0);
      expect(await queue.getLockedEtherAmount()).to.equal(0);
      expect(await queue.harness__getLastReportTimestamp()).to.equal(0);
    });
  });

  context("_sendValue", () => {
    it("Reverts if not enough ether", async () => {
      await expect(queue.harness__sendValue(stranger, ether("1.00"))).to.be.revertedWithCustomError(
        queue,
        "NotEnoughEther",
      );
    });

    it("Reverts if not successful transfer", async () => {
      await setBalance(queueAddress, ether("10.00"));

      await receiver.mock__setCanReceive(false);

      await expect(queue.harness__sendValue(receiver, ether("1.00"))).to.be.revertedWithCustomError(
        queue,
        "CantSendValueRecipientMayHaveReverted",
      );
    });

    it("Sends value to the recipient", async () => {
      await setBalance(queueAddress, ether("10.00"));

      const balanceBefore = await provider.getBalance(stranger);

      await queue.harness__sendValue(stranger, ether("1.00"));

      const balanceAfter = await provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(ether("1.00"));
    });
  });

  context("_calcBatch", () => {
    it("Returns shareRate and shares for equal values", async () => {
      const timestamp = await time.latest();

      const prevRequest = {
        cumulativeStETH: 1000,
        cumulativeShares: 1000,
        owner: owner.address,
        timestamp,
        claimed: false,
        finalized: false,
        reportTimestamp: timestamp,
      };

      const request = {
        ...prevRequest,
        cumulativeStETH: 2000,
        cumulativeShares: 2000,
      };

      const batch = await queue.harness__calcBatch(prevRequest, request);

      expect(batch.shareRate).to.equal(shareRate(1n), "batch->shareRate");
      expect(batch.shares).to.equal(1000, "batch->shares");
    });

    it("Returns shareRate and shares for different values", async () => {
      const timestamp = await time.latest();

      const prevRequest = {
        cumulativeStETH: 2000,
        cumulativeShares: 1000,
        owner: owner.address,
        timestamp,
        claimed: false,
        finalized: false,
        reportTimestamp: timestamp,
      };

      const request = {
        ...prevRequest,
        cumulativeStETH: 6000,
        cumulativeShares: 3000,
      };

      const batch = await queue.harness__calcBatch(prevRequest, request);

      expect(batch.shareRate).to.equal(shareRate(2n), "batch->shareRate");
      expect(batch.shares).to.equal(2000, "batch->shares");
    });
  });

  context("_getLastReportTimestamp", () => {
    it("Returns 0 if no reports", async () => {
      expect(await queue.harness__getLastReportTimestamp()).to.equal(0);
    });

    it("Returns the last report timestamp", async () => {
      const timestamp = await time.latest();

      await queue.harness__setLastReportTimestamp(timestamp);

      expect(await queue.harness__getLastReportTimestamp()).to.equal(timestamp);
    });
  });

  context("_setLastRequestId", () => {
    it("Sets the last request id", async () => {
      expect(await queue.getLastRequestId()).to.equal(0);

      await queue.harness__setLastRequestId(1);

      expect(await queue.getLastRequestId()).to.equal(1);
    });
  });

  context("_setLastFinalizedRequestId", () => {
    it("Sets the last finalized request id", async () => {
      expect(await queue.getLastFinalizedRequestId()).to.equal(0);

      await queue.harness__setLastFinalizedRequestId(1);

      expect(await queue.getLastFinalizedRequestId()).to.equal(1);
    });
  });

  context("_setLastCheckpointIndex", () => {
    it("Sets the last checkpoint index", async () => {
      expect(await queue.getLastCheckpointIndex()).to.equal(0);

      await queue.harness__setLastCheckpointIndex(1);

      expect(await queue.getLastCheckpointIndex()).to.equal(1);
    });
  });

  context("_setLockedEtherAmount", () => {
    it("Sets the locked ether amount", async () => {
      expect(await queue.getLockedEtherAmount()).to.equal(0);

      await queue.harness__setLockedEtherAmount(ether("100.00"));

      expect(await queue.getLockedEtherAmount()).to.equal(ether("100.00"));
    });
  });

  context("_setLastReportTimestamp", () => {
    it("Sets the last report timestamp", async () => {
      const timestamp = await time.latest();

      expect(await queue.harness__getLastReportTimestamp()).to.equal(0);

      await queue.harness__setLastReportTimestamp(timestamp);

      expect(await queue.harness__getLastReportTimestamp()).to.equal(timestamp);
    });
  });
});
