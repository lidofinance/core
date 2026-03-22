import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import { Lido, WithdrawalQueueERC721 } from "typechain-types";

import { ether, findEventsWithInterfaces, ONE_GWEI } from "lib";
import {
  finalizeWQViaSubmit,
  getProtocolContext,
  ProtocolContext,
  reportWithEffectiveClDiff,
  resetCLBalanceDecreaseWindow,
} from "lib/protocol";
import { depositValidatorsWithoutReport } from "lib/protocol/helpers/staking";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

describe("Integration: Withdrawal edge cases", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalState: string;

  let holder: HardhatEthersSigner;
  let lido: Lido;
  let wq: WithdrawalQueueERC721;
  const DEPOSITS_RESERVE_TARGET = ether("25");

  const assertBufferAllocationInvariants = async () => {
    const buffered = await lido.getBufferedEther();
    const depositsReserveTarget = await lido.getDepositsReserveTarget();
    const depositsReserve = await lido.getDepositsReserve();
    const withdrawalsReserve = await lido.getWithdrawalsReserve();
    const depositable = await lido.getDepositableEther();
    const unfinalized = await wq.unfinalizedStETH();

    expect(depositsReserveTarget).to.equal(DEPOSITS_RESERVE_TARGET, "Deposits reserve target mismatch");
    expect(depositsReserve).to.be.lte(buffered, "Deposits reserve should not exceed buffered ether");
    expect(depositsReserve).to.be.lte(depositsReserveTarget, "Deposits reserve should not exceed target");
    expect(depositable).to.equal(buffered - withdrawalsReserve, "Depositable should equal buffered minus reserve");
    expect(withdrawalsReserve).to.be.lte(unfinalized, "Reserve should not exceed unfinalized withdrawals demand");
    expect(withdrawalsReserve).to.be.lte(buffered, "Reserve should not exceed buffered ether");
  };

  const getModuleAccountingReportParams = async (postCLBalanceWei: bigint) => {
    const { stakingRouter } = ctx.contracts;
    const stakingModuleIds = await stakingRouter.getStakingModuleIds();
    const modules: { moduleId: bigint; validatorsBalanceGwei: bigint; pendingBalanceGwei: bigint }[] = [];
    let totalValidatorsBalanceGwei = 0n;
    let totalPendingBalanceGwei = 0n;

    for (const moduleId of stakingModuleIds) {
      const [validatorsBalanceGwei, pendingBalanceGwei] = await stakingRouter.getStakingModuleStateAccounting(moduleId);
      if (validatorsBalanceGwei === 0n && pendingBalanceGwei === 0n) continue;

      modules.push({ moduleId, validatorsBalanceGwei, pendingBalanceGwei });
      totalValidatorsBalanceGwei += validatorsBalanceGwei;
      totalPendingBalanceGwei += pendingBalanceGwei;
    }

    const totalReportedValidatorsBalanceGwei = postCLBalanceWei / ONE_GWEI - totalPendingBalanceGwei;
    const stakingModuleIdsWithUpdatedBalance: bigint[] = [];
    const validatorBalancesGweiByStakingModule: bigint[] = [];
    const pendingBalancesGweiByStakingModule: bigint[] = [];
    let remainingReportedValidatorsBalanceGwei = totalReportedValidatorsBalanceGwei;
    let remainingValidatorsBalanceGwei = totalValidatorsBalanceGwei;

    for (let index = 0; index < modules.length; ++index) {
      const { moduleId, validatorsBalanceGwei, pendingBalanceGwei } = modules[index];
      const isLastModule = index === modules.length - 1;
      const reportedValidatorsBalanceGwei =
        isLastModule || remainingValidatorsBalanceGwei === 0n
          ? remainingReportedValidatorsBalanceGwei
          : (remainingReportedValidatorsBalanceGwei * validatorsBalanceGwei) / remainingValidatorsBalanceGwei;

      stakingModuleIdsWithUpdatedBalance.push(moduleId);
      validatorBalancesGweiByStakingModule.push(reportedValidatorsBalanceGwei);
      pendingBalancesGweiByStakingModule.push(pendingBalanceGwei);

      remainingReportedValidatorsBalanceGwei -= reportedValidatorsBalanceGwei;
      remainingValidatorsBalanceGwei -= validatorsBalanceGwei;
    }

    return {
      stakingModuleIdsWithUpdatedBalance,
      validatorBalancesGweiByStakingModule,
      pendingBalancesGweiByStakingModule,
    };
  };

  const reportWithEffectiveClDiffPreservingPending = async (effectiveClDiff: bigint, skipWithdrawals = false) => {
    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport, depositedSinceLastReport } =
      await ctx.contracts.lido.getBalanceStats();
    const postCLBalanceWei =
      clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport + depositedSinceLastReport + effectiveClDiff;

    await reportWithEffectiveClDiff(ctx, effectiveClDiff, {
      excludeVaultsBalances: true,
      skipWithdrawals,
      ...(await getModuleAccountingReportParams(postCLBalanceWei)),
    });
  };

  const seedProtocolPendingBaseline = async (depositsCount: bigint) => {
    await depositValidatorsWithoutReport(ctx, NOR_MODULE_ID, depositsCount);
    await reportWithEffectiveClDiffPreservingPending(0n, true);
  };

  before(async () => {
    ctx = await getProtocolContext();
    lido = ctx.contracts.lido;
    wq = ctx.contracts.withdrawalQueue;

    snapshot = await Snapshot.take();

    [, holder] = await ethers.getSigners();
    await setBalance(holder.address, ether("1000000"));

    await finalizeWQViaSubmit(ctx);

    const agent = await ctx.getSigner("agent");
    await lido.connect(agent).setDepositsReserveTarget(DEPOSITS_RESERVE_TARGET);
  });

  after(async () => await Snapshot.restore(snapshot));

  context("Bunker mode", () => {
    beforeEach(async () => (originalState = await Snapshot.take()));
    afterEach(async () => await Snapshot.restore(originalState));
    it("Should handle bunker mode with multiple batches", async () => {
      await resetCLBalanceDecreaseWindow(ctx);

      const amount = ether("100");
      const withdrawalAmount = ether("10");

      expect(await lido.balanceOf(holder.address)).to.equal(0);

      await lido.connect(holder).approve(wq.target, amount);
      await lido.connect(holder).submit(ethers.ZeroAddress, { value: amount });
      await assertBufferAllocationInvariants();

      await seedProtocolPendingBaseline(1n);

      const stethInitialBalance = await lido.balanceOf(holder.address);

      await reportWithEffectiveClDiffPreservingPending(ether("-1"));
      await assertBufferAllocationInvariants();

      const stethFirstNegativeReportBalance = await lido.balanceOf(holder.address);

      expect(stethInitialBalance).to.be.gt(stethFirstNegativeReportBalance);
      expect(await wq.isBunkerModeActive()).to.be.true;

      // First withdrawal request
      const firstRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
      const firstRequestReceipt = await firstRequestTx.wait();
      const [firstRequestEvent] = findEventsWithInterfaces(firstRequestReceipt!, "WithdrawalRequested", [wq.interface]);
      const firstRequestId = firstRequestEvent!.args.requestId;

      await reportWithEffectiveClDiffPreservingPending(ether("-0.1"));
      await assertBufferAllocationInvariants();

      const stethSecondNegativeReportBalance = await lido.balanceOf(holder.address);

      expect(stethFirstNegativeReportBalance).to.be.gt(stethSecondNegativeReportBalance);
      expect(await wq.isBunkerModeActive()).to.be.true;

      // Second withdrawal request
      const secondRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
      const secondRequestReceipt = await secondRequestTx.wait();
      const [secondRequestEvent] = findEventsWithInterfaces(secondRequestReceipt!, "WithdrawalRequested", [
        wq.interface,
      ]);
      const secondRequestId = secondRequestEvent!.args.requestId;

      const requestIds = [firstRequestId, secondRequestId];
      const [firstStatus, secondStatus] = await wq.getWithdrawalStatus([...requestIds]);

      // Amount of requested ETH should be equal, but shares are different
      // because second request was affected by negative rebase twice
      expect(firstStatus.amountOfStETH).to.equal(secondStatus.amountOfStETH);
      expect(firstStatus.amountOfShares).to.be.lt(secondStatus.amountOfShares);

      await reportWithEffectiveClDiffPreservingPending(ether("0.0001"));
      await assertBufferAllocationInvariants();

      expect(await wq.isBunkerModeActive()).to.be.false;

      const statuses = await wq.getWithdrawalStatus([...requestIds]);
      statuses.forEach((status) => {
        expect(status.isFinalized).to.be.true;
      });

      const lastCheckpointIndex = await wq.getLastCheckpointIndex();
      const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);
      const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
      const claimReceipt = await claimTx.wait();

      // First claimed request should be less than requested amount because it caught negative rebase
      const claimEvents = findEventsWithInterfaces(claimReceipt!, "WithdrawalClaimed", [wq.interface]);
      expect(claimEvents![0].args.amountOfETH).to.be.lt(withdrawalAmount);
      expect(claimEvents![1].args.amountOfETH).to.equal(withdrawalAmount);
    });
  });

  context("Missed oracle report", () => {
    beforeEach(async () => (originalState = await Snapshot.take()));

    afterEach(async () => await Snapshot.restore(originalState));

    it("should handle missed oracle report", async () => {
      const amount = ether("100");

      expect(await lido.balanceOf(holder.address)).to.equal(0);

      // Submit initial stETH deposit
      await lido.connect(holder).submit(ethers.ZeroAddress, { value: amount });
      await assertBufferAllocationInvariants();

      await seedProtocolPendingBaseline(3n);
      await reportWithEffectiveClDiffPreservingPending(ether("0.001"));
      await assertBufferAllocationInvariants();

      // Create withdrawal request
      await lido.connect(holder).approve(wq.target, amount);
      const requestTx = await wq.connect(holder).requestWithdrawals([amount], holder.address);
      const requestReceipt = await requestTx.wait();
      const [requestEvent] = findEventsWithInterfaces(requestReceipt!, "WithdrawalRequested", [wq.interface]);
      const requestId = requestEvent!.args.requestId;
      const requestIds = [requestId];

      // Skip next report by waiting extra time
      const timeBeforeMissedReport = await time.latest();
      await time.increase(24 * 60 * 60); // 24 hours
      const timeAfterMissedReport = await time.latest();

      // Check request not finalized after missed report
      const [status] = await wq.getWithdrawalStatus([...requestIds]);
      expect(timeBeforeMissedReport).to.be.lt(timeAfterMissedReport);
      expect(status.isFinalized).to.be.false;

      // Submit next report to finalize request
      await reportWithEffectiveClDiffPreservingPending(ether("0.001"));
      await assertBufferAllocationInvariants();

      // Verify request finalized
      const [finalizedStatus] = await wq.getWithdrawalStatus([...requestIds]);
      expect(finalizedStatus.isFinalized).to.be.true;

      // Claim withdrawal
      const lastCheckpointIndex = await wq.getLastCheckpointIndex();
      const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);
      const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
      const claimReceipt = await claimTx.wait();

      // Verify claimed amount matches requested amount
      const claimEvents = findEventsWithInterfaces(claimReceipt!, "WithdrawalClaimed", [wq.interface]);
      expect(claimEvents![0].args.amountOfETH).to.equal(amount);
    });
  });

  context("Several rebases", () => {
    const requestIds: bigint[] = [];
    const withdrawalAmount = ether("10");

    before(async () => (originalState = await Snapshot.take()));

    after(async () => await Snapshot.restore(originalState));

    it("should handle first rebase correctly", async () => {
      await resetCLBalanceDecreaseWindow(ctx);

      const amount = ether("100");

      expect(await lido.balanceOf(holder.address)).to.equal(0);

      await lido.connect(holder).approve(wq.target, amount);
      await lido.connect(holder).submit(ethers.ZeroAddress, { value: amount });
      await assertBufferAllocationInvariants();

      // First rebase - positive
      await seedProtocolPendingBaseline(1n);
      await reportWithEffectiveClDiffPreservingPending(ether("0.0000001"));
      await assertBufferAllocationInvariants();
      expect(await wq.isBunkerModeActive()).to.be.false;

      // Create first withdrawal request
      const firstRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
      const firstRequestReceipt = await firstRequestTx.wait();
      const [firstRequestEvent] = findEventsWithInterfaces(firstRequestReceipt!, "WithdrawalRequested", [wq.interface]);
      requestIds.push(firstRequestEvent!.args.requestId);
    });

    it("should handle second (negative) rebase correctly", async () => {
      // Second rebase - negative
      await reportWithEffectiveClDiffPreservingPending(ether("-0.1"));
      await assertBufferAllocationInvariants();
      expect(await wq.isBunkerModeActive()).to.be.true;

      // Verify first request finalized
      const [firstStatus] = await wq.getWithdrawalStatus([requestIds[0]]);
      expect(firstStatus.isFinalized).to.be.true;

      // Create second withdrawal request
      const secondRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
      const secondRequestReceipt = await secondRequestTx.wait();
      const [secondRequestEvent] = findEventsWithInterfaces(secondRequestReceipt!, "WithdrawalRequested", [
        wq.interface,
      ]);
      requestIds.push(secondRequestEvent!.args.requestId);
    });

    it("should handle third (negative) rebase correctly", async () => {
      // Third rebase - negative
      await reportWithEffectiveClDiffPreservingPending(ether("-0.1"));
      await assertBufferAllocationInvariants();
      expect(await wq.isBunkerModeActive()).to.be.true;

      // Create third withdrawal request
      const thirdRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
      const thirdRequestReceipt = await thirdRequestTx.wait();
      const [thirdRequestEvent] = findEventsWithInterfaces(thirdRequestReceipt!, "WithdrawalRequested", [wq.interface]);
      requestIds.push(thirdRequestEvent!.args.requestId);
    });

    it("should handle fourth (positive) rebase correctly", async () => {
      // Fourth rebase - positive
      await reportWithEffectiveClDiffPreservingPending(ether("0.0000001"));
      await assertBufferAllocationInvariants();
      expect(await wq.isBunkerModeActive()).to.be.false;

      // Verify all requests finalized
      const statuses = await wq.getWithdrawalStatus(requestIds);
      for (const status of statuses) {
        expect(status.isFinalized).to.be.true;
      }
    });

    it("should handle claim correctly", async () => {
      // Claim withdrawals
      const lastCheckpointIndex = await wq.getLastCheckpointIndex();
      const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);
      const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
      const claimReceipt = await claimTx.wait();

      // Verify claimed amounts
      const claimEvents = findEventsWithInterfaces(claimReceipt!, "WithdrawalClaimed", [wq.interface]);
      const firstClaimed = claimEvents![0].args.amountOfETH;
      const secondClaimed = claimEvents![1].args.amountOfETH;
      const thirdClaimed = claimEvents![2].args.amountOfETH;

      expect(firstClaimed).to.be.lt(withdrawalAmount);
      expect(secondClaimed).to.be.lt(withdrawalAmount);
      expect(thirdClaimed).to.equal(withdrawalAmount);
    });
  });
});
