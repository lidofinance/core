import { expect } from "chai";
import { ContractTransactionReceipt, LogDescription, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { advanceChainTime, ether, impersonate, ONE_GWEI, updateBalance } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import {
  ensureFirstPostMigrationReport,
  getProtocolContext,
  getReportTimeElapsed,
  normalizeWithdrawalVaultBaseline,
  ProtocolContext,
  removeStakingLimit,
  report,
  reportWithEffectiveClDiff,
  seedProtocolPendingBaseline,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";
import { MAX_BASIS_POINTS, ONE_DAY, SHARE_RATE_PRECISION } from "test/suite/constants";

describe("Integration: Accounting", () => {
  let ctx: ProtocolContext;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    await reportWithEffectiveClDiff(ctx, 0n, { reportElVault: false, skipWithdrawals: true });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot)); // Rollback to the initial state pre deployment

  const getFirstEvent = (receipt: ContractTransactionReceipt, eventName: string) => {
    const events = ctx.getEvents(receipt, eventName);
    return events[0];
  };

  const shareRateFromEvent = (tokenRebasedEvent: LogDescription) => {
    const sharesRateBefore =
      (tokenRebasedEvent.args.preTotalEther * SHARE_RATE_PRECISION) / tokenRebasedEvent.args.preTotalShares;
    const sharesRateAfter =
      (tokenRebasedEvent.args.postTotalEther * SHARE_RATE_PRECISION) / tokenRebasedEvent.args.postTotalShares;
    return { sharesRateBefore, sharesRateAfter };
  };

  const roundToGwei = (value: bigint) => {
    return (value / ONE_GWEI) * ONE_GWEI;
  };

  const rebaseLimitWei = async () => {
    const { oracleReportSanityChecker, lido } = ctx.contracts;

    const maxPositiveTokeRebase = await oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());

    expect(maxPositiveTokeRebase).to.be.greaterThanOrEqual(0);

    return (maxPositiveTokeRebase * internalEther) / LIMITER_PRECISION_BASE;
  };

  /**
   * Submit a report without moving current CL pending into active validators.
   *
   * These Accounting cases check vault and buffer effects, not CL activation.
   * The raw `clDiff` still includes deposits up to the current report ref slot,
   * but the same `depositedForCurrentReport` amount is reported as pending.
   * This keeps the CL rebase neutral for the scenario under test.
   */
  async function reportWithNoClActivation(params: NonNullable<Parameters<typeof report>[1]>) {
    await waitNextAvailableReportTime(ctx);

    const { clPendingBalanceAtLastReport, depositedForCurrentReport } = await ctx.contracts.lido.getBalanceStats();

    return report(ctx, {
      ...params,
      waitNextReportTime: false,
      clDiff: depositedForCurrentReport,
      clPendingBalanceGwei: (clPendingBalanceAtLastReport + depositedForCurrentReport) / ONE_GWEI,
    });
  }

  function getWithdrawalParamsFromEvent(tx: ContractTransactionReceipt): {
    amountOfETHLocked: bigint;
    sharesBurntAmount: bigint;
    sharesToBurn: bigint;
  } {
    const withdrawalsFinalized = getFirstEvent(tx, "WithdrawalsFinalized")?.args;
    const amountOfETHLocked = withdrawalsFinalized?.amountOfETHLocked ?? 0n;
    const sharesToBurn = withdrawalsFinalized?.sharesToBurn ?? 0n;

    const sharesBurnt = getFirstEvent(tx, "SharesBurnt")?.args;
    const sharesBurntAmount = sharesBurnt?.sharesAmount ?? 0n;

    return { amountOfETHLocked, sharesBurntAmount, sharesToBurn };
  }

  const sharesRateFromEvent = (tx: ContractTransactionReceipt) => {
    const tokenRebasedEvent = getFirstEvent(tx, "TokenRebased");
    expect(tokenRebasedEvent.args.preTotalEther).to.be.greaterThanOrEqual(0);
    expect(tokenRebasedEvent.args.postTotalEther).to.be.greaterThanOrEqual(0);
    return [
      (tokenRebasedEvent.args.preTotalEther * SHARE_RATE_PRECISION) / tokenRebasedEvent.args.preTotalShares,
      (tokenRebasedEvent.args.postTotalEther * SHARE_RATE_PRECISION) / tokenRebasedEvent.args.postTotalShares,
    ];
  };

  // Get shares burn limit from oracle report sanity checker contract when NO changes in pooled Ether are expected
  async function sharesToBurnToReachRebaseLimit() {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    const rebaseLimit = await oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const rebaseLimitPlus1 = rebaseLimit + LIMITER_PRECISION_BASE;

    const internalShares = (await lido.getTotalShares()) - (await lido.getExternalShares());

    // Derived from:
    // rebaseLimit = (postShareRate - preShareRate) / preShareRate
    return (internalShares * rebaseLimit) / rebaseLimitPlus1;
  }

  async function readState() {
    const { lido, accountingOracle, elRewardsVault, withdrawalVault, burner, withdrawalQueue } = ctx.contracts;

    const lastProcessingRefSlot = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollected = await lido.getTotalELRewardsCollected();
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());
    const internalShares = (await lido.getTotalShares()) - (await lido.getExternalShares());
    const lidoBalance = await ethers.provider.getBalance(lido);
    const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault);
    const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault);
    const burnerShares = await lido.sharesOf(burner);
    const bufferedEther = await lido.getBufferedEther();
    const depositsReserveTarget = await lido.getDepositsReserveTarget();
    const depositsReserve = await lido.getDepositsReserve();
    const withdrawalsReserve = await lido.getWithdrawalsReserve();
    const depositableEther = await lido.getDepositableEther();
    const unfinalizedStETH = await withdrawalQueue.unfinalizedStETH();

    return {
      lastProcessingRefSlot,
      totalELRewardsCollected,
      internalEther,
      internalShares,
      lidoBalance,
      elRewardsVaultBalance,
      withdrawalVaultBalance,
      burnerShares,
      bufferedEther,
      depositsReserveTarget,
      depositsReserve,
      withdrawalsReserve,
      depositableEther,
      unfinalizedStETH,
    };
  }

  async function expectStateChanges(
    beforeState: Awaited<ReturnType<typeof readState>>,
    expectedDelta: Partial<Awaited<ReturnType<typeof readState>>>,
  ) {
    const {
      lastProcessingRefSlot,
      totalELRewardsCollected,
      internalEther,
      internalShares,
      lidoBalance,
      elRewardsVaultBalance,
      withdrawalVaultBalance,
      burnerShares,
      bufferedEther,
      depositsReserveTarget,
      depositsReserve,
      withdrawalsReserve,
      depositableEther,
      unfinalizedStETH,
    } = await readState();

    expect(lastProcessingRefSlot).to.be.greaterThan(
      beforeState.lastProcessingRefSlot,
      "Last processing ref slot mismatch",
    );

    expect(totalELRewardsCollected).to.equal(
      beforeState.totalELRewardsCollected + (expectedDelta.totalELRewardsCollected ?? 0n),
      "Total EL rewards collected mismatch",
    );
    expect(internalEther).to.equal(
      beforeState.internalEther + (expectedDelta.internalEther ?? 0n),
      "Internal ether mismatch",
    );
    expect(lidoBalance).to.equal(beforeState.lidoBalance + (expectedDelta.lidoBalance ?? 0n), "Lido balance mismatch");
    expect(elRewardsVaultBalance).to.equal(
      beforeState.elRewardsVaultBalance + (expectedDelta.elRewardsVaultBalance ?? 0n),
      "El rewards vault balance mismatch",
    );
    expect(withdrawalVaultBalance).to.equal(
      beforeState.withdrawalVaultBalance + (expectedDelta.withdrawalVaultBalance ?? 0n),
      "Withdrawal vault balance mismatch",
    );
    expect(burnerShares).to.equal(
      beforeState.burnerShares + (expectedDelta.burnerShares ?? 0n),
      "Burner shares mismatch",
    );
    expect(internalShares).to.equal(
      beforeState.internalShares + (expectedDelta.internalShares ?? 0n),
      "Internal shares mismatch",
    );

    expect(depositsReserveTarget).to.equal(
      beforeState.depositsReserveTarget,
      "Deposits reserve target should not change during report processing",
    );
    const expectedDepositsReserve = bufferedEther < depositsReserveTarget ? bufferedEther : depositsReserveTarget;
    expect(depositsReserve).to.equal(
      expectedDepositsReserve,
      "Deposits reserve should be synced to min(buffered ether, deposits reserve target)",
    );
    expect(depositsReserve).to.be.lte(depositsReserveTarget, "Deposits reserve should not exceed target");
    expect(depositsReserve).to.be.lte(bufferedEther, "Deposits reserve should not exceed buffered ether");
    expect(depositableEther).to.equal(
      bufferedEther - withdrawalsReserve,
      "Depositable should equal buffered minus withdrawals reserve",
    );
    expect(withdrawalsReserve).to.be.lte(unfinalizedStETH, "Withdrawals reserve should not exceed demand");
    expect(withdrawalsReserve).to.be.lte(bufferedEther, "Withdrawals reserve should not exceed buffered ether");
  }

  async function expectTransferFeesEvents(
    reportTxReceipt: ContractTransactionReceipt,
    noRewards: boolean = false,
  ): Promise<bigint> {
    const { stakingRouter, csm, cmv2 } = ctx.contracts;

    const { amountOfETHLocked } = getWithdrawalParamsFromEvent(reportTxReceipt);
    const hasWithdrawals = amountOfETHLocked !== 0n;

    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");
    let expectedRewardsDistributionEventsCount = 0n;

    if (!noRewards) {
      expectedRewardsDistributionEventsCount = BigInt(await stakingRouter.getStakingModulesCount()) + 2n; // +1 initial mint, +1 for the treasury
      if (csm !== undefined) {
        if ((await stakingRouter.getModuleValidatorsBalance(ctx.modules.csm!.id)) > 0) {
          // +1 for the CSM internal transfer
          expectedRewardsDistributionEventsCount += 1n;
        } else {
          // no reward transfer to modules with 0 validators balance
          expectedRewardsDistributionEventsCount -= 1n;
        }
      }
      if (cmv2 !== undefined) {
        if ((await stakingRouter.getModuleValidatorsBalance(ctx.modules.cmv2!.id)) > 0) {
          // +1 for the CSM internal transfer
          expectedRewardsDistributionEventsCount += 1n;
        } else {
          // no reward transfer to modules with 0 validators balance
          expectedRewardsDistributionEventsCount -= 1n;
        }
      }
    }
    const expectedWithdrawalsTransferEventCount = hasWithdrawals ? 1n : 0n;
    expect(transferSharesEvents.length).to.equal(
      expectedWithdrawalsTransferEventCount + expectedRewardsDistributionEventsCount,
      "Expected transfer of shares to treasury, WQ and staking modules",
    );

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .filter(({ args }) => args.from === ZeroAddress) // only minted shares
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const tokenRebasedEvent = getFirstEvent(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent.args.sharesMintedAsFees).to.equal(mintedSharesSum);

    return mintedSharesSum;
  }

  // Ensure the whale account has enough shares, e.g. on scratch deployments
  async function ensureWhaleHasFunds(amount: bigint) {
    const { lido, wstETH } = ctx.contracts;
    const wstEthBalance = await lido.sharesOf(wstETH);
    if (wstEthBalance < amount) {
      await removeStakingLimit(ctx);
      const wstEthSigner = await impersonate(wstETH.address, ether("10001"));
      await lido.connect(wstEthSigner).submit(ZeroAddress, { value: ether("10000") });
    }
  }

  it("Should revert report on sanity checks if CL rebase is too large", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;

    const maxCLRebaseViaLimiter = (await rebaseLimitWei()) + 1n;

    await expect(
      report(ctx, {
        clDiff: maxCLRebaseViaLimiter,
        reportElVault: false,
        reportBurner: false,
        skipWithdrawals: true,
      }),
    ).to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectTotalCLBalanceIncrease");
  });

  it("Should account correctly with no CL rebase", async () => {
    const beforeState = await readState();

    // Report
    const { reportTx } = await report(ctx, { clDiff: 0n, reportElVault: false });

    const reportTxReceipt = (await reportTx!.wait())!;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: 0n,
      internalEther: amountOfETHLocked * -1n,
      internalShares: sharesBurntAmount * -1n,
      lidoBalance: amountOfETHLocked * -1n,
    });

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased");
    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateBefore).to.be.lessThanOrEqual(sharesRateAfter);
  });

  it("Should account correctly with non-zero deposits and withdrawals reserves", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;
    const agent = await ctx.getSigner("agent");

    await lido.connect(agent).setDepositsReserveTarget(ether("10"));
    await lido.connect(agent).submit(ZeroAddress, { value: ether("90") });
    await lido.connect(agent).approve(withdrawalQueue, ether("5"));
    await withdrawalQueue.connect(agent).requestWithdrawals([ether("5")], agent.address);
    await reportWithEffectiveClDiff(ctx, 0n, {
      reportElVault: false,
      reportBurner: false,
      skipWithdrawals: true,
      dryRun: false,
    });

    const beforeState = await readState();
    expect(beforeState.depositsReserveTarget).to.equal(ether("10"));
    expect(beforeState.depositsReserve).to.equal(ether("10"));
    expect(beforeState.withdrawalsReserve).to.be.gt(0n);
    const expectedWithdrawalsReserve =
      beforeState.unfinalizedStETH < beforeState.bufferedEther - beforeState.depositsReserve
        ? beforeState.unfinalizedStETH
        : beforeState.bufferedEther - beforeState.depositsReserve;
    expect(beforeState.withdrawalsReserve).to.equal(expectedWithdrawalsReserve);
    expect(beforeState.depositableEther).to.equal(beforeState.bufferedEther - beforeState.withdrawalsReserve);

    // Deferred target increase must not change effective reserves before report processing.
    const increasedTarget = beforeState.bufferedEther + ether("1000");
    await lido.connect(agent).setDepositsReserveTarget(increasedTarget);
    expect(await lido.getDepositsReserve()).to.equal(beforeState.depositsReserve);
    expect(await lido.getWithdrawalsReserve()).to.equal(beforeState.withdrawalsReserve);
    const beforeStateAfterTargetUpdate = await readState();
    expect(beforeStateAfterTargetUpdate.depositsReserveTarget).to.equal(increasedTarget);

    const requestTimestampMargin = (await ctx.contracts.oracleReportSanityChecker.getOracleReportLimits())
      .requestTimestampMargin;
    await advanceChainTime(requestTimestampMargin + 1n);

    await ensureFirstPostMigrationReport(ctx);
    await normalizeWithdrawalVaultBaseline(ctx, 0n);
    const refSlot = (await ctx.contracts.hashConsensus.getCurrentFrame()).refSlot;

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

    const dryRunBefore = await report(ctx, dryRunParams);
    expect(dryRunBefore.data.withdrawalFinalizationBatches.length).to.be.gt(
      0,
      "Expected non-empty withdrawal finalization batches in dry-run report",
    );
    const [lockBefore] = await withdrawalQueue.prefinalize(
      dryRunBefore.data.withdrawalFinalizationBatches,
      dryRunBefore.data.simulatedShareRate,
    );
    expect(lockBefore).to.be.lte(beforeStateAfterTargetUpdate.withdrawalsReserve);

    const { reportTx } = await report(ctx, { clDiff: 0n, reportElVault: false, reportBurner: false });
    const reportTxReceipt = (await reportTx!.wait())!;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeStateAfterTargetUpdate, {
      totalELRewardsCollected: 0n,
      internalEther: amountOfETHLocked * -1n,
      internalShares: sharesBurntAmount * -1n,
      lidoBalance: amountOfETHLocked * -1n,
    });

    const afterState = await readState();
    expect(afterState.depositsReserveTarget).to.equal(increasedTarget);
    expect(afterState.depositsReserve).to.equal(afterState.bufferedEther);
    expect(afterState.withdrawalsReserve).to.equal(0n);
    expect(afterState.depositableEther).to.equal(afterState.bufferedEther);
  });

  it("Should account correctly with negative CL rebase", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;
    const { maxCLBalanceDecreaseBP } = await oracleReportSanityChecker.getOracleReportLimits();
    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport } = await lido.getBalanceStats();
    const maxDecrease =
      ((clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport) * maxCLBalanceDecreaseBP) / MAX_BASIS_POINTS;
    const CL_REBASE_AMOUNT = -roundToGwei(maxDecrease / 2n);

    const beforeState = await readState();

    // Report
    const params = { clDiff: CL_REBASE_AMOUNT, reportElVault: false, skipWithdrawals: true };
    const { reportTx } = await report(ctx, params);
    const reportTxReceipt = (await reportTx!.wait())!;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: 0n,
      internalEther: amountOfETHLocked * -1n + CL_REBASE_AMOUNT,
      internalShares: sharesBurntAmount * -1n,
      lidoBalance: amountOfETHLocked * -1n,
    });

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased");
    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateAfter).to.be.lessThan(sharesRateBefore);

    const ethDistributedEvent = ctx.getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance).to.equal(
      ethDistributedEvent[0].args.postCLBalance - CL_REBASE_AMOUNT,
    );
  });

  it("Should account correctly with positive CL rebase close to the limits", async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await seedProtocolPendingBaseline(ctx, NOR_MODULE_ID);

    const { annualBalanceIncreaseBPLimit } = await oracleReportSanityChecker.getOracleReportLimits();
    const { clValidatorsBalanceAtLastReport, clPendingBalanceAtLastReport } = await lido.getBalanceStats();

    const { timeElapsed } = await getReportTimeElapsed(ctx);

    // `report()` submits the raw post-vs-pre CL delta. In this seeded scenario the
    // pending baseline is activated inside the same report, so the raw boundary is
    // the safety-cap component computed from the post-activation validators base.
    let rebaseAmount =
      ((clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport) * annualBalanceIncreaseBPLimit * timeElapsed) /
      (365n * ONE_DAY) /
      MAX_BASIS_POINTS;
    rebaseAmount = roundToGwei(rebaseAmount);

    const beforeState = await readState();

    // Report
    const { reportTx } = (await report(ctx, { clDiff: rebaseAmount, reportElVault: false })) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const mintedSharesSum = await expectTransferFeesEvents(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: 0n,
      internalEther: amountOfETHLocked * -1n + rebaseAmount,
      internalShares: sharesBurntAmount * -1n + mintedSharesSum,
      lidoBalance: amountOfETHLocked * -1n,
    });

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");

    const ethDistributedEvent = ctx.getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance + rebaseAmount).to.equal(
      ethDistributedEvent[0].args.postCLBalance,
      "ETHDistributed: CL balance has not increased",
    );
  });

  it("Should account correctly if no EL rewards", async () => {
    const beforeState = await readState();

    const params = { clDiff: 0n, reportElVault: false };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: 0n,
      internalEther: amountOfETHLocked * -1n,
      internalShares: sharesBurntAmount * -1n,
      lidoBalance: amountOfETHLocked * -1n,
    });

    expect(ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")).to.be.empty;
    expect(ctx.getEvents(reportTxReceipt, "ELRewardsReceived")).to.be.empty;
  });

  it("Should account correctly normal EL rewards", async () => {
    const { elRewardsVault } = ctx.contracts;

    await updateBalance(elRewardsVault.address, ether("1"));

    const elRewards = await ethers.provider.getBalance(elRewardsVault.address);
    expect(elRewards).to.be.greaterThan(0, "Expected EL vault to be non-empty");

    const beforeState = await readState();

    const params = { clDiff: 0n, reportElVault: true };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: elRewards,
      internalEther: amountOfETHLocked * -1n + elRewards,
      internalShares: sharesBurntAmount * -1n,
      lidoBalance: amountOfETHLocked * -1n + elRewards,
      elRewardsVaultBalance: elRewards * -1n,
    });

    const elRewardsReceivedEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
    expect(elRewardsReceivedEvent.args.amount).to.equal(elRewards);
  });

  it("Should account correctly EL rewards at limits", async () => {
    const { elRewardsVault } = ctx.contracts;

    const elRewards = await rebaseLimitWei();
    await impersonate(elRewardsVault.address, elRewards);

    const beforeState = await readState();

    // Report
    const params = { clDiff: 0n, reportElVault: true };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount, sharesToBurn } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: elRewards,
      internalEther: amountOfETHLocked * -1n + elRewards,
      internalShares: sharesBurntAmount * -1n,
      lidoBalance: amountOfETHLocked * -1n + elRewards,
      elRewardsVaultBalance: elRewards * -1n,
      burnerShares: sharesToBurn - sharesBurntAmount,
    });

    const elRewardsReceivedEvent = ctx.getEvents(reportTxReceipt, "ELRewardsReceived")[0];
    expect(elRewardsReceivedEvent.args.amount).to.equal(elRewards);
  });

  it("Should account correctly EL rewards above limits", async () => {
    const { elRewardsVault } = ctx.contracts;

    const rewardsExcess = ether("10");
    const expectedRewards = await rebaseLimitWei();
    const elRewards = expectedRewards + rewardsExcess;

    await impersonate(elRewardsVault.address, elRewards);

    const beforeState = await readState();

    const params = { clDiff: 0n, reportElVault: true };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount, sharesToBurn } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: expectedRewards,
      internalEther: expectedRewards - amountOfETHLocked,
      internalShares: 0n - sharesBurntAmount,
      lidoBalance: expectedRewards - amountOfETHLocked,
      elRewardsVaultBalance: 0n - expectedRewards,
      burnerShares: sharesToBurn - sharesBurntAmount,
    });

    const elRewardsReceivedEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
    expect(elRewardsReceivedEvent.args.amount).to.equal(expectedRewards);
  });

  it("Should account correctly with no elRewards and no withdrawals accounted for", async () => {
    const beforeState = await readState();

    // Report
    const params = { clDiff: 0n, reportElVault: false };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      internalEther: 0n - amountOfETHLocked,
      internalShares: 0n - sharesBurntAmount,
      lidoBalance: 0n - amountOfETHLocked,
    });

    expect(ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")).to.be.empty;
    expect(ctx.getEvents(reportTxReceipt, "ELRewardsReceived")).to.be.empty;
  });

  it("Should account correctly with withdrawals at limits", async () => {
    await ensureFirstPostMigrationReport(ctx);

    const withdrawals = await rebaseLimitWei();
    // Seed WVB as already known to ORSC, not as fresh CL withdrawals. The
    // target report still passes full WVB, so only Accounting's smoothing cap
    // decides how much can be collected.
    await normalizeWithdrawalVaultBaseline(ctx, withdrawals);

    const beforeState = await readState();

    // Report
    const params = { clDiff: 0n, reportElVault: false, reportWithdrawalsVault: true };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount, sharesToBurn } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const mintedSharesSum = await expectTransferFeesEvents(reportTxReceipt);

    await expectStateChanges(beforeState, {
      internalEther: withdrawals - amountOfETHLocked,
      internalShares: mintedSharesSum - sharesBurntAmount,
      lidoBalance: withdrawals - amountOfETHLocked,
      withdrawalVaultBalance: 0n - withdrawals,
      burnerShares: sharesToBurn - sharesBurntAmount,
    });

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const withdrawalsReceivedEvent = ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")[0];
    expect(withdrawalsReceivedEvent.args.amount).to.equal(withdrawals);
  });

  it("Should account correctly with withdrawals above limits", async () => {
    await ensureFirstPostMigrationReport(ctx);

    const expectedWithdrawals = await rebaseLimitWei();
    const withdrawalsExcess = ether("10");
    const withdrawals = expectedWithdrawals + withdrawalsExcess;

    // Seed WVB as already known to ORSC, not as fresh CL withdrawals. The
    // target report still passes full WVB, so only Accounting's smoothing cap
    // decides how much can be collected.
    await normalizeWithdrawalVaultBaseline(ctx, withdrawals);

    const beforeState = await readState();

    const params = { clDiff: 0n, reportElVault: false, reportWithdrawalsVault: true };
    const { reportTx } = (await reportWithNoClActivation(params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount, sharesToBurn } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const mintedSharesSum = await expectTransferFeesEvents(reportTxReceipt);

    await expectStateChanges(beforeState, {
      internalEther: expectedWithdrawals - amountOfETHLocked,
      internalShares: mintedSharesSum - sharesBurntAmount,
      lidoBalance: expectedWithdrawals - amountOfETHLocked,
      withdrawalVaultBalance: 0n - expectedWithdrawals,
      burnerShares: sharesToBurn - sharesBurntAmount,
    });

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const withdrawalsReceivedEvent = getFirstEvent(reportTxReceipt, "WithdrawalsReceived");
    expect(withdrawalsReceivedEvent.args.amount).to.equal(expectedWithdrawals);
  });

  it("Should account correctly shares burn at limits", async () => {
    const { lido, burner, wstETH: whale, accounting } = ctx.contracts;
    await ensureWhaleHasFunds(ether("10000"));

    const sharesLimit = await sharesToBurnToReachRebaseLimit();
    const initialBurnerBalance = await lido.sharesOf(burner);

    const whaleSigner = await impersonate(whale, ether("1"));
    await lido.connect(whaleSigner).approve(burner, await lido.getPooledEthByShares(sharesLimit));

    const coverShares = sharesLimit / 3n;
    const noCoverShares = sharesLimit - sharesLimit / 3n;

    const accountingSigner = await impersonate(accounting.address, ether("1"));
    await expect(burner.connect(accountingSigner).requestBurnShares(whale, noCoverShares))
      .to.emit(burner, "StETHBurnRequested")
      .withArgs(false, accountingSigner, await lido.getPooledEthByShares(noCoverShares), noCoverShares);

    await expect(burner.connect(accountingSigner).requestBurnSharesForCover(whale, coverShares))
      .to.emit(burner, "StETHBurnRequested")
      .withArgs(true, accountingSigner, await lido.getPooledEthByShares(coverShares), coverShares);

    expect(await lido.sharesOf(burner)).to.equal(sharesLimit + initialBurnerBalance, "Burner shares mismatch");

    const stateBefore = await readState();

    // Report
    const { reportTx } = await reportWithEffectiveClDiff(ctx, 0n, { reportElVault: false, skipWithdrawals: true });
    const reportTxReceipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const { sharesBurntAmount, sharesToBurn, amountOfETHLocked } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(stateBefore, {
      internalShares: -1n * sharesBurntAmount,
      // On Hoodi, this report can finalize withdrawal requests at the same time.
      // WQ shares first arrive in Burner, and smoothing may leave part of them for
      // the next report; sharesLimit itself is checked separately from withdrawal burn below.
      burnerShares: sharesToBurn - sharesBurntAmount,
      internalEther: -1n * amountOfETHLocked,
      lidoBalance: -1n * amountOfETHLocked,
    });

    const burntDueToWithdrawals = sharesToBurn - (await lido.sharesOf(burner)) + initialBurnerBalance;
    expect(burntDueToWithdrawals).to.be.greaterThanOrEqual(0);
    expect(sharesBurntAmount - burntDueToWithdrawals).to.equal(sharesLimit, "SharesBurnt: sharesAmount mismatch");

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");
  });

  it("Should account correctly shares burn above limits (no withdrawals)", async () => {
    const { lido, burner, wstETH: whale, accounting } = ctx.contracts;

    await ensureWhaleHasFunds(ether("10000"));

    const limit = await sharesToBurnToReachRebaseLimit();
    const excess = 42n;
    const limitWithExcess = limit + excess;

    expect(await lido.sharesOf(burner)).to.equal(0, "Burner balance mismatch");

    // request to burn limit+ shares
    const whaleSigner = await impersonate(whale, ether("1"));
    await lido.connect(whaleSigner).approve(burner, await lido.getPooledEthByShares(limitWithExcess));
    const accountingSigner = await impersonate(accounting, ether("1"));
    await expect(burner.connect(accountingSigner).requestBurnShares(whale, limitWithExcess))
      .to.emit(burner, "StETHBurnRequested")
      .withArgs(false, accountingSigner, await lido.getPooledEthByShares(limitWithExcess), limitWithExcess);

    const stateBefore = await readState();

    const limit2 = await sharesToBurnToReachRebaseLimit();
    expect(limit2).to.equal(limit);

    // Report
    await reportWithEffectiveClDiff(ctx, 0n, { reportElVault: false, skipWithdrawals: true });

    await expectStateChanges(stateBefore, {
      internalShares: -1n * limit,
      burnerShares: -1n * limit,
    });
  });

  it("Should account correctly overfill both vaults", async () => {
    const { withdrawalVault, elRewardsVault } = ctx.contracts;

    await ensureFirstPostMigrationReport(ctx);

    const limit = await rebaseLimitWei();
    const excess = limit / 2n; // 2nd report will take two halves of the excess of the limit size
    const limitWithExcess = limit + excess;

    // Seed WVB as already known to ORSC, not as fresh CL withdrawals. The
    // target report still passes full WVB, so only Accounting's smoothing cap
    // decides how much can be collected.
    await normalizeWithdrawalVaultBaseline(ctx, limitWithExcess);
    await setBalance(elRewardsVault.address, limitWithExcess);

    const beforeState = await readState();

    let elVaultExcess = 0n;
    let amountOfETHLocked = 0n;
    let updatedLimit = 0n;
    let mintedSharesSum = 0n;
    {
      const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: true, skipWithdrawals: true };
      const { reportTx } = (await reportWithNoClActivation(params)) as {
        reportTx: TransactionResponse;
        extraDataTx: TransactionResponse;
      };
      const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

      updatedLimit = await rebaseLimitWei();
      elVaultExcess = limitWithExcess - (updatedLimit - excess);

      amountOfETHLocked = getWithdrawalParamsFromEvent(reportTxReceipt).amountOfETHLocked;

      expect(await ethers.provider.getBalance(withdrawalVault.address)).to.equal(
        excess,
        "Expected withdrawals vault to be filled with excess rewards",
      );

      const withdrawalsReceivedEvent = getFirstEvent(reportTxReceipt, "WithdrawalsReceived");
      expect(withdrawalsReceivedEvent.args.amount).to.equal(limit, "WithdrawalsReceived: amount mismatch");

      const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);
      expect(elRewardsVaultBalance).to.equal(limitWithExcess, "Expected EL vault to be kept unchanged");
      expect(ctx.getEvents(reportTxReceipt, "ELRewardsReceived")).to.be.empty;

      mintedSharesSum += await expectTransferFeesEvents(reportTxReceipt);
    }
    {
      const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: true, skipWithdrawals: true };
      const { reportTx } = (await reportWithNoClActivation(params)) as {
        reportTx: TransactionResponse;
        extraDataTx: TransactionResponse;
      };
      const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

      const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault.address);
      expect(withdrawalVaultBalance).to.equal(0, "Expected withdrawals vault to be emptied");

      const withdrawalsReceivedEvent = getFirstEvent(reportTxReceipt, "WithdrawalsReceived");
      expect(withdrawalsReceivedEvent.args.amount).to.equal(excess, "WithdrawalsReceived: amount mismatch");

      const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);
      expect(elRewardsVaultBalance).to.equal(elVaultExcess, "Expected EL vault to be filled with excess rewards");

      const elRewardsEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
      expect(elRewardsEvent.args.amount).to.equal(updatedLimit - excess, "ELRewardsReceived: amount mismatch");

      mintedSharesSum += await expectTransferFeesEvents(reportTxReceipt);
    }
    {
      const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: true, skipWithdrawals: true };
      const { reportTx } = (await reportWithNoClActivation(params)) as {
        reportTx: TransactionResponse;
        extraDataTx: TransactionResponse;
      };
      const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

      expect(ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")).to.be.empty;

      const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);
      expect(elRewardsVaultBalance).to.equal(0, "Expected EL vault to be emptied");

      const rewardsEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
      expect(rewardsEvent.args.amount).to.equal(elVaultExcess, "ELRewardsReceived: amount mismatch");

      mintedSharesSum += await expectTransferFeesEvents(reportTxReceipt, true);
    }

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: limitWithExcess,
      internalEther: limitWithExcess * 2n - amountOfETHLocked,
      lidoBalance: limitWithExcess * 2n - amountOfETHLocked,
      elRewardsVaultBalance: 0n - limitWithExcess,
      withdrawalVaultBalance: 0n - limitWithExcess,
      internalShares: mintedSharesSum,
    });
  });
});
