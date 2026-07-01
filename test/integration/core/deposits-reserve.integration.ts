import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, ether, updateBalance } from "lib";
import {
  depositAllocatedValidatorsFromBuffer,
  depositValidatorsWithoutReport,
  ensureFirstPostMigrationReport,
  finalizeWQViaSubmit,
  getProtocolContext,
  normalizeWithdrawalVaultBaseline,
  ProtocolContext,
  report,
  reportWithoutClActivation,
  setStakingLimit,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Deposits reserve", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const neutralReportParams = {
    reportElVault: false,
    reportBurner: false,
    skipWithdrawals: true,
  } as const;

  /**
   * Prepare a report that must not include WVB rewards.
   *
   * Deposits-reserve cases check buffer and reserve math. On a fork, ORSC can
   * already remember a non-zero WithdrawalVault balance from history. This setup
   * moves past the migration-only report if needed and aligns WVB history to
   * zero, so the next report cannot collect unrelated WVB rewards.
   */
  const prepareNoWvbReport = async () => {
    await ensureFirstPostMigrationReport(ctx);
    await normalizeWithdrawalVaultBaseline(ctx, 0n);
  };

  const requestWithdrawalWithAvailableBuffer = async (requestAmount: bigint) => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const bufferedBefore = await lido.getBufferedEther();
    const minBufferedAfter = (await lido.getDepositsReserveTarget()) + requestAmount;
    const requiredTopUp = minBufferedAfter > bufferedBefore ? minBufferedAfter - bufferedBefore : 0n;
    const submitValue = requiredTopUp > requestAmount ? requiredTopUp : requestAmount;

    await lido.connect(holder).submit(ZeroAddress, { value: submitValue });
    await lido.connect(holder).approve(withdrawalQueue, requestAmount);
    await withdrawalQueue.connect(holder).requestWithdrawals([requestAmount], holder.address);

    const buffered = await lido.getBufferedEther();
    const depositsReserve = await lido.getDepositsReserve();
    const withdrawalsReserve = await lido.getWithdrawalsReserve();
    const unfinalized = await withdrawalQueue.unfinalizedStETH();
    const withdrawalAvailableBuffer = buffered - depositsReserve;
    const expectedWithdrawalsReserve =
      withdrawalAvailableBuffer < unfinalized ? withdrawalAvailableBuffer : unfinalized;

    expect(withdrawalsReserve).to.equal(expectedWithdrawalsReserve);
    expect(withdrawalsReserve).to.be.gt(0n);

    return withdrawalsReserve;
  };

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder, stranger] = await ethers.getSigners();
    reserveManager = holder;

    await setStakingLimit(ctx, ether("200000"), ether("20"));
    await finalizeWQViaSubmit(ctx);

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      // Grant reserve management permission once for the non-agent actor used in ACL tests.
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }
  });

  beforeEach(async () => {
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("Authorizes reserve target updates via BUFFER_RESERVE_MANAGER_ROLE only", async () => {
    const { lido } = ctx.contracts;

    await expect(lido.connect(stranger).setDepositsReserveTarget(ether("1"))).to.be.revertedWith("APP_AUTH_FAILED");
    await expect(lido.connect(reserveManager).setDepositsReserveTarget(ether("1")))
      .to.emit(lido, "DepositsReserveTargetSet")
      .withArgs(ether("1"));
  });

  it("Applies target decrease immediately and defers target increase until report sync", async () => {
    const { lido } = ctx.contracts;

    await lido.connect(holder).submit(ZeroAddress, { value: ether("100") });
    await lido.connect(reserveManager).setDepositsReserveTarget(ether("40"));
    await reportWithoutClActivation(ctx, neutralReportParams);

    const targetBefore = await lido.getDepositsReserveTarget();
    const reserveBeforeIncrease = await lido.getDepositsReserve();
    expect(targetBefore).to.equal(ether("40"));
    expect(reserveBeforeIncrease).to.equal(targetBefore);

    const increasedTarget = targetBefore + ether("2");
    // Increase is stored in target immediately but reserve value is synchronized on report.
    await lido.connect(reserveManager).setDepositsReserveTarget(increasedTarget);
    expect(await lido.getDepositsReserveTarget()).to.equal(increasedTarget);

    expect(await lido.getDepositsReserve()).to.equal(reserveBeforeIncrease);
    await reportWithoutClActivation(ctx, neutralReportParams);
    expect(await lido.getDepositsReserve()).to.equal(increasedTarget);

    const increasedAgain = increasedTarget + ether("10");
    await lido.connect(reserveManager).setDepositsReserveTarget(increasedAgain);
    expect(await lido.getDepositsReserveTarget()).to.equal(increasedAgain);
    expect(await lido.getDepositsReserve()).to.equal(increasedTarget);

    const decreasedTarget = increasedTarget - ether("1");
    // Decrease is applied immediately to avoid reducing withdrawals budget unexpectedly.
    await lido.connect(reserveManager).setDepositsReserveTarget(decreasedTarget);
    expect(await lido.getDepositsReserve()).to.equal(decreasedTarget);
  });

  it("Releases deposits reserve when target is set to zero and preserves reserve/depositable invariants", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const requestAmount = ether("5");
    await lido.connect(holder).submit(ZeroAddress, { value: ether("100") });
    await lido.connect(holder).approve(withdrawalQueue, requestAmount);
    await withdrawalQueue.connect(holder).requestWithdrawals([requestAmount], holder.address);

    await lido.connect(reserveManager).setDepositsReserveTarget(ether("40"));
    // First set a non-zero effective deposits reserve, then verify explicit reset to zero.
    await reportWithoutClActivation(ctx, neutralReportParams);
    expect(await lido.getDepositsReserve()).to.equal(ether("40"));

    await lido.connect(reserveManager).setDepositsReserveTarget(0n);
    expect(await lido.getDepositsReserve()).to.equal(0n);

    const buffered = await lido.getBufferedEther();
    const withdrawalsReserve = await lido.getWithdrawalsReserve();
    const unfinalized = await withdrawalQueue.unfinalizedStETH();

    const expectedWithdrawalsReserve = buffered < unfinalized ? buffered : unfinalized;
    // With deposits reserve released, withdrawals reserve is bounded only by buffered and unfinalized demand.
    expect(withdrawalsReserve).to.equal(expectedWithdrawalsReserve);
    expect(await lido.getDepositableEther()).to.equal(buffered - expectedWithdrawalsReserve);
  });

  it("Reaches increased target on the next report after deferred increase", async () => {
    const { lido } = ctx.contracts;

    await lido.connect(holder).submit(ZeroAddress, { value: ether("100") });
    await lido.connect(reserveManager).setDepositsReserveTarget(ether("40"));
    // First report materializes initial target in effective reserve.
    await reportWithoutClActivation(ctx, neutralReportParams);
    expect(await lido.getDepositsReserve()).to.equal(ether("40"));

    await lido.connect(reserveManager).setDepositsReserveTarget(ether("20"));
    expect(await lido.getDepositsReserve()).to.equal(ether("20"));

    await lido.connect(reserveManager).setDepositsReserveTarget(ether("40"));
    expect(await lido.getDepositsReserve()).to.equal(ether("20"));

    // Second report applies deferred increase back to the new target.
    await reportWithoutClActivation(ctx, neutralReportParams);

    expect(await lido.getDepositsReserveTarget()).to.equal(ether("40"));
    expect(await lido.getDepositsReserve()).to.equal(ether("40"));
  });

  it("Computes finalization budget from withdrawal-available buffer, excluding deposits reserve", async () => {
    const { lido, withdrawalQueue, locator } = ctx.contracts;

    const requestAmount = ether("1");
    await requestWithdrawalWithAvailableBuffer(requestAmount);

    const requestTimestampMargin = (await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits())
      .requestTimestampMargin;
    await advanceChainTime(requestTimestampMargin + 1n);

    const buffered = await lido.getBufferedEther();
    const withdrawalVaultBalance = await ethers.provider.getBalance(await locator.withdrawalVault());
    // Set target above buffered ether including possible WVB transfer on arbitrary fork blocks.
    await lido.connect(reserveManager).setDepositsReserveTarget(buffered + withdrawalVaultBalance + ether("1000"));
    await reportWithoutClActivation(ctx, neutralReportParams);
    expect(await lido.getWithdrawalsReserve()).to.equal(0n);

    const elRewardsVaultAddress = await locator.elRewardsVault();
    const extraEthBudget = ether("5");
    await updateBalance(elRewardsVaultAddress, extraEthBudget);

    // The report is built for fixed refSlot, so deposits after refSlot must not increase its finalization budget.
    await lido.connect(holder).submit(ZeroAddress, { value: ether("3") });
    expect(await lido.getWithdrawalsReserve()).to.equal(0n);

    // Freeze report inputs at refSlot and evaluate finalization budget from dry-run output.
    await prepareNoWvbReport();
    const refSlot = (await ctx.contracts.hashConsensus.getCurrentFrame()).refSlot;
    const { data } = await report(ctx, {
      refSlot,
      waitNextReportTime: false,
      dryRun: true,
      clDiff: 0n,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: false,
      excludeVaultsBalances: false,
    });

    expect(data.withdrawalFinalizationBatches.length).to.be.gt(
      0,
      "Expected non-empty withdrawal finalization batches for tooling budget check",
    );
    const [ethToLock] = await withdrawalQueue.prefinalize(data.withdrawalFinalizationBatches, data.simulatedShareRate);

    expect(ethToLock).to.be.lte(extraEthBudget);
  });

  it("Keeps fixed-refSlot finalization batches stable after late deposits", async () => {
    const { lido, withdrawalQueue, locator } = ctx.contracts;

    const requestAmount = ether("1");
    await lido.connect(holder).submit(ZeroAddress, { value: ether("200") });
    await lido.connect(holder).approve(withdrawalQueue, requestAmount);
    await withdrawalQueue.connect(holder).requestWithdrawals([requestAmount], holder.address);

    const requestTimestampMargin = (await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits())
      .requestTimestampMargin;
    await advanceChainTime(requestTimestampMargin + 1n);

    const depositsReserveBefore = await lido.getDepositsReserve();
    const depositsTargetBefore = await lido.getDepositsReserveTarget();

    const elRewardsVaultAddress = await locator.elRewardsVault();
    await updateBalance(elRewardsVaultAddress, ether("3"));

    await prepareNoWvbReport();
    const refSlot = (await ctx.contracts.hashConsensus.getCurrentFrame()).refSlot;
    // Build dry-run report with explicit refSlot to make batches deterministic.
    const dryRunParams = {
      refSlot,
      waitNextReportTime: false,
      dryRun: true,
      clDiff: 0n,
      reportElVault: true,
      reportWithdrawalsVault: false,
      reportBurner: false,
      excludeVaultsBalances: false,
    } as const;

    const before = await report(ctx, dryRunParams);
    expect(before.data.withdrawalFinalizationBatches.length).to.be.gt(
      0,
      "Expected non-empty withdrawal finalization batches before late deposit",
    );
    const [beforeLock] = await withdrawalQueue.prefinalize(
      before.data.withdrawalFinalizationBatches,
      before.data.simulatedShareRate,
    );

    // Late deposit after refSlot should not affect withdrawals finalization result.
    await lido.connect(holder).submit(ZeroAddress, { value: ether("7") });
    expect(await lido.getDepositsReserveTarget()).to.equal(depositsTargetBefore);
    expect(await lido.getDepositsReserve()).to.be.gte(depositsReserveBefore);

    const after = await report(ctx, dryRunParams);
    expect(after.data.withdrawalFinalizationBatches.length).to.be.gt(
      0,
      "Expected non-empty withdrawal finalization batches after late deposit",
    );
    const [afterLockAtRefSlotShareRate] = await withdrawalQueue.prefinalize(
      after.data.withdrawalFinalizationBatches,
      before.data.simulatedShareRate,
    );

    expect(afterLockAtRefSlotShareRate).to.equal(beforeLock);
    // Batches and ETH lock at the refSlot share rate must stay unchanged.
    expect(after.data.withdrawalFinalizationBatches).to.deep.equal(before.data.withdrawalFinalizationBatches);
  });

  it("Keeps withdrawals finalization budget stable after reserve target increase post-refSlot", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const requestAmount = ether("20");
    await requestWithdrawalWithAvailableBuffer(requestAmount);

    const requestTimestampMargin = (await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits())
      .requestTimestampMargin;
    await advanceChainTime(requestTimestampMargin + 1n);

    const depositsReserveTargetBefore = await lido.getDepositsReserveTarget();
    const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
    const depositsReserveBefore = await lido.getDepositsReserve();
    expect(withdrawalsReserveBefore).to.be.gt(0n);

    await prepareNoWvbReport();
    const refSlot = (await ctx.contracts.hashConsensus.getCurrentFrame()).refSlot;
    // Build dry-run data at fixed refSlot, then change target and re-run with the same refSlot.
    const dryRunParams = {
      refSlot,
      waitNextReportTime: false,
      dryRun: true,
      clDiff: 0n,
      reportElVault: false,
      reportWithdrawalsVault: false,
      reportBurner: false,
      excludeVaultsBalances: true,
    } as const;

    const before = await report(ctx, dryRunParams);
    expect(before.data.withdrawalFinalizationBatches.length).to.be.gt(
      0,
      "Expected non-empty withdrawal finalization batches before reserve target increase",
    );
    const [beforeLock] = await withdrawalQueue.prefinalize(
      before.data.withdrawalFinalizationBatches,
      before.data.simulatedShareRate,
    );

    // Target increase after refSlot is deferred and must not affect current withdrawals finalization budget.
    await lido.connect(reserveManager).setDepositsReserveTarget(depositsReserveTargetBefore + ether("20"));
    expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);
    expect(await lido.getDepositsReserve()).to.equal(depositsReserveBefore);

    const after = await report(ctx, dryRunParams);
    expect(after.data.withdrawalFinalizationBatches.length).to.be.gt(
      0,
      "Expected non-empty withdrawal finalization batches after reserve target increase",
    );
    const [afterLock] = await withdrawalQueue.prefinalize(
      after.data.withdrawalFinalizationBatches,
      after.data.simulatedShareRate,
    );

    expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);
    expect(afterLock).to.be.lte(withdrawalsReserveBefore);
    expect(beforeLock).to.be.lte(withdrawalsReserveBefore);
  });

  it("Does not reduce withdrawals reserve when CL deposits consume depositable ether", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const requestAmount = ether("10");
    await lido.connect(reserveManager).submit(ZeroAddress, { value: ether("3200") });
    await lido.connect(reserveManager).approve(withdrawalQueue, requestAmount);
    await withdrawalQueue.connect(reserveManager).requestWithdrawals([requestAmount], reserveManager.address);

    const bufferedBefore = await lido.getBufferedEther();
    const depositsReserveBefore = await lido.getDepositsReserve();
    const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
    const depositableBefore = await lido.getDepositableEther();
    expect(withdrawalsReserveBefore).to.be.gt(0n);
    expect(depositableBefore).to.equal(bufferedBefore - withdrawalsReserveBefore);

    // Spend depositable ether through CL deposit path.
    const { consumed } = await depositAllocatedValidatorsFromBuffer(ctx);

    const bufferedAfter = await lido.getBufferedEther();
    const depositsReserveAfter = await lido.getDepositsReserve();
    const withdrawalsReserveAfter = await lido.getWithdrawalsReserve();
    const depositableAfter = await lido.getDepositableEther();

    expect(consumed).to.be.gt(0n, "Expected non-zero buffered ether consumption during CL deposit");
    // CL deposit consumes only depositable ether; withdrawals reserve must remain unchanged.
    expect(depositsReserveAfter).to.be.lte(depositsReserveBefore);
    expect(withdrawalsReserveAfter).to.equal(withdrawalsReserveBefore);
    expect(depositableAfter).to.equal(depositableBefore - consumed);
    expect(depositableAfter).to.equal(bufferedAfter - withdrawalsReserveAfter);
  });

  it("Keeps fixed-refSlot finalization budget bounded after spending depositable ether post-refSlot", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const requestAmount = ether("20");
    await requestWithdrawalWithAvailableBuffer(requestAmount);

    const requestTimestampMargin = (await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits())
      .requestTimestampMargin;
    await advanceChainTime(requestTimestampMargin + 1n);

    const depositsReserveBefore = await lido.getDepositsReserve();
    const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
    expect(withdrawalsReserveBefore).to.be.gt(0n);

    await prepareNoWvbReport();
    const refSlot = (await ctx.contracts.hashConsensus.getCurrentFrame()).refSlot;
    // Fix refSlot first, then spend depositable ether to emulate post-refSlot CL deposits.
    const reportParams = {
      refSlot,
      waitNextReportTime: false,
      clDiff: 0n,
      reportElVault: false,
      reportWithdrawalsVault: false,
      reportBurner: false,
      excludeVaultsBalances: true,
    } as const;

    const before = await report(ctx, { ...reportParams, dryRun: true });
    expect(before.data.withdrawalFinalizationBatches.length).to.be.gt(0);
    const [lockBefore] = await withdrawalQueue.prefinalize(
      before.data.withdrawalFinalizationBatches,
      before.data.simulatedShareRate,
    );

    const bufferedBeforeSpend = await lido.getBufferedEther();
    await depositValidatorsWithoutReport(ctx, 1n);
    const bufferedAfterSpend = await lido.getBufferedEther();
    expect(bufferedAfterSpend).to.be.lt(bufferedBeforeSpend);

    const depositsReserveAfterSpend = await lido.getDepositsReserve();
    const withdrawalsReserveAfterSpend = await lido.getWithdrawalsReserve();
    expect(depositsReserveAfterSpend).to.be.lte(depositsReserveBefore);
    expect(withdrawalsReserveAfterSpend).to.equal(withdrawalsReserveBefore);

    const after = await report(ctx, { ...reportParams, dryRun: true });
    expect(after.data.withdrawalFinalizationBatches.length).to.be.gt(0);
    const [lockAfter] = await withdrawalQueue.prefinalize(
      after.data.withdrawalFinalizationBatches,
      after.data.simulatedShareRate,
    );
    expect(lockAfter).to.be.gt(0n);
    // Finalization lock remains bounded by precomputed withdrawals reserve from fixed refSlot.
    expect(lockAfter).to.be.lte(withdrawalsReserveBefore);
    expect(lockBefore).to.be.lte(withdrawalsReserveBefore);
  });
});
