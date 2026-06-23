import { expect } from "chai";
import { ContractTransactionReceipt, TransactionResponse, ZeroAddress } from "ethers";
import hre, { ethers } from "hardhat";

import { setBalance, setStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import { ether, toGwei } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import { getProtocolContext, ProtocolContext, report, waitNextAvailableReportTime } from "lib/protocol";

import { Snapshot } from "test/suite";
import { SHARE_RATE_PRECISION } from "test/suite/constants";

// Mirrors ORSC layout: slots 0/1 are packed limits, 2 is reportData, 3 is secondOpinionOracle.
const ORSC_LAST_VAULT_BALANCE_AFTER_TRANSFER_SLOT = 4n;

describe("Integration: Accounting WVB baseline", () => {
  let ctx: ProtocolContext;
  let baseState: string;

  before(async function () {
    if (hre.network.name !== "hardhat") {
      throw new Error("Accounting WVB integration requires the Hardhat network for snapshot and vault funding setup");
    }

    ctx = await getProtocolContext();
    await ctx.contracts.oracleReportSanityChecker.lastVaultBalanceAfterTransfer();
    baseState = await Snapshot.take();
  });

  beforeEach(async () => {
    baseState = await Snapshot.refresh(baseState);
  });

  after(async () => {
    if (baseState) {
      await Snapshot.restore(baseState);
    }
  });

  const getFirstEvent = (receipt: ContractTransactionReceipt, eventName: string) => {
    const events = ctx.getEvents(receipt, eventName);
    return events[0];
  };

  const rebaseLimitWei = async () => {
    const { oracleReportSanityChecker, lido } = ctx.contracts;

    const maxPositiveTokenRebase = await oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());

    expect(maxPositiveTokenRebase).to.be.greaterThanOrEqual(0);

    return (maxPositiveTokenRebase * internalEther) / LIMITER_PRECISION_BASE;
  };

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
      expectedRewardsDistributionEventsCount = BigInt(await stakingRouter.getStakingModulesCount()) + 2n;
      if (csm !== undefined) {
        if ((await stakingRouter.getModuleValidatorsBalance(ctx.modules.csm!.id)) > 0) {
          expectedRewardsDistributionEventsCount += 1n;
        } else {
          expectedRewardsDistributionEventsCount -= 1n;
        }
      }
      if (cmv2 !== undefined) {
        if ((await stakingRouter.getModuleValidatorsBalance(ctx.modules.cmv2!.id)) > 0) {
          expectedRewardsDistributionEventsCount += 1n;
        } else {
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
      .slice(hasWithdrawals ? 1 : 0)
      .filter(({ args }) => args.from === ZeroAddress)
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const tokenRebasedEvent = getFirstEvent(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent.args.sharesMintedAsFees).to.equal(mintedSharesSum);

    return mintedSharesSum;
  }

  async function seedWvbBaseline(baselineWVB: bigint) {
    const { oracleReportSanityChecker, withdrawalVault } = ctx.contracts;
    const reportDataCountBefore = await oracleReportSanityChecker.getReportDataCount();
    const lastReportTimestampBefore = await oracleReportSanityChecker.lastReportTimestamp();
    const isPostMigrationFirstReportDoneBefore = await oracleReportSanityChecker.isPostMigrationFirstReportDone();

    await setBalance(withdrawalVault.address, baselineWVB);
    await setStorageAt(
      oracleReportSanityChecker.address,
      ORSC_LAST_VAULT_BALANCE_AFTER_TRANSFER_SLOT,
      ethers.toBeHex(baselineWVB, 32),
    );

    expect(await oracleReportSanityChecker.lastVaultBalanceAfterTransfer()).to.equal(
      baselineWVB,
      "Seeded WVB baseline mismatch",
    );
    expect(await ethers.provider.getBalance(withdrawalVault.address)).to.equal(
      baselineWVB,
      "Seeded withdrawal vault balance mismatch",
    );
    expect(await oracleReportSanityChecker.getReportDataCount()).to.equal(
      reportDataCountBefore,
      "WVB baseline seed must not alter ORSC report history",
    );
    expect(await oracleReportSanityChecker.lastReportTimestamp()).to.equal(
      lastReportTimestampBefore,
      "WVB baseline seed must not alter ORSC logical report timestamp",
    );
    expect(await oracleReportSanityChecker.isPostMigrationFirstReportDone()).to.equal(
      isPostMigrationFirstReportDoneBefore,
      "WVB baseline seed must not alter ORSC migration report flag",
    );
  }

  async function prepareScenarioBaseline<T extends { baselineWVB: bigint }>(
    makeScenario: () => Promise<T>,
  ): Promise<T> {
    const scenario = await makeScenario();
    await seedWvbBaseline(scenario.baselineWVB);
    return scenario;
  }

  async function buildModuleBalancesForValidators(reportedValidatorsGwei: bigint) {
    const { stakingRouter } = ctx.contracts;
    const stakingModuleIdsWithUpdatedBalance = [...(await stakingRouter.getStakingModuleIds())];
    const modulesCount = stakingModuleIdsWithUpdatedBalance.length;
    expect(modulesCount).to.be.greaterThan(0);
    expect(reportedValidatorsGwei).to.be.greaterThanOrEqual(BigInt(modulesCount));

    const previousBalances = await Promise.all(
      stakingModuleIdsWithUpdatedBalance.map(async (moduleId) => {
        const [validatorsBalanceGwei] = await stakingRouter.getStakingModuleStateAccounting(moduleId);
        return validatorsBalanceGwei;
      }),
    );
    const previousTotal = previousBalances.reduce((sum, balance) => sum + balance, 0n);

    if (previousTotal === 0n) {
      const validatorBalancesGweiByStakingModule = stakingModuleIdsWithUpdatedBalance.map((_, index) =>
        index === 0 ? reportedValidatorsGwei - BigInt(modulesCount - 1) : 1n,
      );
      return { stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule };
    }

    let remainingBalance = reportedValidatorsGwei;
    let remainingPreviousTotal = previousTotal;
    const validatorBalancesGweiByStakingModule = previousBalances.map((previousBalance, index) => {
      if (index === previousBalances.length - 1) return remainingBalance;

      const nextBalance = (reportedValidatorsGwei * previousBalance) / previousTotal;
      remainingBalance -= nextBalance;
      remainingPreviousTotal -= previousBalance;
      return remainingPreviousTotal === 0n ? remainingBalance : nextBalance;
    });

    return { stakingModuleIdsWithUpdatedBalance, validatorBalancesGweiByStakingModule };
  }

  async function reportWithBaselineWVB(
    reportedWVB: bigint,
    params: {
      reportElVault?: boolean;
      skipWithdrawals?: boolean;
    } = {},
  ) {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    await waitNextAvailableReportTime(ctx);

    const lastVaultBalanceAfterTransfer = await oracleReportSanityChecker.lastVaultBalanceAfterTransfer();
    expect(reportedWVB).to.be.greaterThanOrEqual(lastVaultBalanceAfterTransfer, "Reported WVB below baseline");
    const freshCLWithdrawals = reportedWVB - lastVaultBalanceAfterTransfer;
    expect(freshCLWithdrawals).to.equal(0n, "Unexpected fresh CL withdrawals in WVB cap scenario");

    const {
      clValidatorsBalanceAtLastReport,
      clPendingBalanceAtLastReport,
      depositedSinceLastReport,
      depositedForCurrentReport,
    } = await lido.getBalanceStats();
    expect(depositedForCurrentReport).to.equal(depositedSinceLastReport, "Report deposits changed across frame");

    const clDiff = depositedForCurrentReport + reportedWVB - freshCLWithdrawals;
    const reportedTotalCL = clValidatorsBalanceAtLastReport + clPendingBalanceAtLastReport + clDiff - reportedWVB;
    const reportedPendingWei = clPendingBalanceAtLastReport + depositedForCurrentReport;
    expect(reportedTotalCL).to.equal(
      clValidatorsBalanceAtLastReport + reportedPendingWei,
      "Reported CL must equal Accounting principal CL",
    );

    const clPendingBalanceGwei = toGwei(reportedPendingWei);
    const reportedValidatorsGwei = toGwei(reportedTotalCL) - clPendingBalanceGwei;
    const moduleBalances = await buildModuleBalancesForValidators(reportedValidatorsGwei);
    const modulesBalanceSum = moduleBalances.validatorBalancesGweiByStakingModule.reduce(
      (sum, balance) => sum + balance,
      0n,
    );
    expect(modulesBalanceSum).to.equal(reportedValidatorsGwei, "Module validators balance sum mismatch");

    return report(ctx, {
      clDiff,
      clPendingBalanceGwei,
      withdrawalVaultBalance: reportedWVB,
      reportWithdrawalsVault: true,
      waitNextReportTime: false,
      ...moduleBalances,
      ...params,
    });
  }

  it("Should account correctly with withdrawals at limits", async () => {
    const { baselineWVB: withdrawals } = await prepareScenarioBaseline(async () => ({
      baselineWVB: await rebaseLimitWei(),
    }));

    const beforeState = await readState();

    const { reportTx } = (await reportWithBaselineWVB(withdrawals, { reportElVault: false })) as {
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
    const { expectedWithdrawals, withdrawals } = await prepareScenarioBaseline(async () => {
      const expectedWithdrawalsAmount = await rebaseLimitWei();
      const withdrawalsExcess = ether("10");
      const withdrawalsAmount = expectedWithdrawalsAmount + withdrawalsExcess;
      return {
        baselineWVB: withdrawalsAmount,
        expectedWithdrawals: expectedWithdrawalsAmount,
        withdrawals: withdrawalsAmount,
      };
    });

    const beforeState = await readState();

    const { reportTx } = (await reportWithBaselineWVB(withdrawals, { reportElVault: false })) as {
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

  it("Should account correctly overfill both vaults", async () => {
    const { limit, excess, limitWithExcess } = await prepareScenarioBaseline(async () => {
      const rebaseLimit = await rebaseLimitWei();
      const rebaseExcess = rebaseLimit / 2n;
      return {
        baselineWVB: rebaseLimit + rebaseExcess,
        limit: rebaseLimit,
        excess: rebaseExcess,
        limitWithExcess: rebaseLimit + rebaseExcess,
      };
    });
    const { elRewardsVault } = ctx.contracts;

    await setBalance(elRewardsVault.address, limitWithExcess);

    const beforeState = await readState();

    let elVaultExcess = 0n;
    let amountOfETHLocked = 0n;
    let updatedLimit = 0n;
    let mintedSharesSum = 0n;
    {
      const { reportTx } = (await reportWithBaselineWVB(limitWithExcess, {
        reportElVault: true,
        skipWithdrawals: true,
      })) as {
        reportTx: TransactionResponse;
        extraDataTx: TransactionResponse;
      };
      const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

      updatedLimit = await rebaseLimitWei();
      elVaultExcess = limitWithExcess - (updatedLimit - excess);

      amountOfETHLocked = getWithdrawalParamsFromEvent(reportTxReceipt).amountOfETHLocked;

      expect(await ethers.provider.getBalance(ctx.contracts.withdrawalVault.address)).to.equal(
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
      const { reportTx } = (await reportWithBaselineWVB(excess, {
        reportElVault: true,
        skipWithdrawals: true,
      })) as {
        reportTx: TransactionResponse;
        extraDataTx: TransactionResponse;
      };
      const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

      const withdrawalVaultBalance = await ethers.provider.getBalance(ctx.contracts.withdrawalVault.address);
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
      const { reportTx } = (await reportWithBaselineWVB(0n, {
        reportElVault: true,
        skipWithdrawals: true,
      })) as {
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
