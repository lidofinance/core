import { expect } from "chai";
import { ContractTransactionReceipt, LogDescription, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, impersonate, log, ONE_GWEI, updateBalance } from "lib";
import { LIMITER_PRECISION_BASE } from "lib/constants";
import {
  finalizeWQViaSubmit,
  getProtocolContext,
  getReportTimeElapsed,
  ProtocolContext,
  removeStakingLimit,
  report,
} from "lib/protocol";

import { Snapshot } from "test/suite";
import { MAX_BASIS_POINTS, ONE_DAY, SHARE_RATE_PRECISION } from "test/suite/constants";

describe("Integration: Accounting", () => {
  let ctx: ProtocolContext;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();
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

  const getWithdrawalParamsFromEvent = (tx: ContractTransactionReceipt) => {
    const withdrawalsFinalized = getFirstEvent(tx, "WithdrawalsFinalized")?.args;
    const amountOfETHLocked = withdrawalsFinalized?.amountOfETHLocked ?? 0n;
    const sharesToBurn = withdrawalsFinalized?.sharesToBurn ?? 0n;

    const sharesBurnt = getFirstEvent(tx, "SharesBurnt")?.args;
    const sharesBurntAmount = sharesBurnt?.sharesAmount ?? 0n;

    return { amountOfETHLocked, sharesBurntAmount, sharesToBurn };
  };

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
  const sharesBurnLimitNoPooledEtherChanges = async () => {
    const { lido, oracleReportSanityChecker } = ctx.contracts;

    const rebaseLimit = await oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const rebaseLimitPlus1 = rebaseLimit + LIMITER_PRECISION_BASE;

    return (((await lido.getTotalShares()) - (await lido.getExternalShares())) * rebaseLimit) / rebaseLimitPlus1;
  };

  async function readState() {
    const { lido, accountingOracle, elRewardsVault, withdrawalVault } = ctx.contracts;

    const lastProcessingRefSlot = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollected = await lido.getTotalELRewardsCollected();
    const internalEther = (await lido.getTotalPooledEther()) - (await lido.getExternalEther());
    const internalShares = (await lido.getTotalShares()) - (await lido.getExternalShares());
    const lidoBalance = await ethers.provider.getBalance(lido.address);
    const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);
    const withdrawalVaultBalance = await ethers.provider.getBalance(withdrawalVault.address);

    return {
      lastProcessingRefSlot,
      totalELRewardsCollected,
      internalEther,
      internalShares,
      lidoBalance,
      elRewardsVaultBalance,
      withdrawalVaultBalance,
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
    } = await readState();

    expect(beforeState.lastProcessingRefSlot).to.be.lessThan(lastProcessingRefSlot);

    expect(beforeState.totalELRewardsCollected + (expectedDelta.totalELRewardsCollected ?? 0n)).to.equal(
      totalELRewardsCollected,
      "Total EL rewards collected mismatch",
    );
    expect(beforeState.internalEther + (expectedDelta.internalEther ?? 0n)).to.equal(
      internalEther,
      "Internal ether mismatch",
    );
    expect(beforeState.internalShares + (expectedDelta.internalShares ?? 0n)).to.equal(
      internalShares,
      "Internal shares mismatch",
    );
    expect(beforeState.lidoBalance + (expectedDelta.lidoBalance ?? 0n)).to.equal(lidoBalance, "Lido balance mismatch");
    expect(beforeState.elRewardsVaultBalance + (expectedDelta.elRewardsVaultBalance ?? 0n)).to.equal(
      elRewardsVaultBalance,
      "El rewards vault balance mismatch",
    );
    expect(beforeState.withdrawalVaultBalance + (expectedDelta.withdrawalVaultBalance ?? 0n)).to.equal(
      withdrawalVaultBalance,
    );
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

    const maxCLRebaseViaLimiter = await rebaseLimitWei();

    // Expected annual limit to shot first
    const rebaseAmount = maxCLRebaseViaLimiter - 1n;

    const params = { clDiff: rebaseAmount, excludeVaultsBalances: true };
    await expect(report(ctx, params)).to.be.revertedWithCustomError(
      oracleReportSanityChecker,
      "IncorrectCLBalanceIncrease(uint256)",
    );
  });

  it("Should account correctly with no CL rebase", async () => {
    const beforeState = await readState();

    // Report
    const { reportTx } = await report(ctx, { clDiff: 0n, excludeVaultsBalances: true });

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

  it("Should account correctly with negative CL rebase", async () => {
    const CL_REBASE_AMOUNT = ether("-100");

    const beforeState = await readState();

    // Report
    const params = { clDiff: CL_REBASE_AMOUNT, excludeVaultsBalances: true, skipWithdrawals: true };
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
    const { lido, stakingRouter, oracleReportSanityChecker } = ctx.contracts;

    const { annualBalanceIncreaseBPLimit } = await oracleReportSanityChecker.getOracleReportLimits();
    const { beaconBalance } = await lido.getBeaconStat();

    const { timeElapsed } = await getReportTimeElapsed(ctx);

    // To calculate the rebase amount close to the annual increase limit
    // we use (ONE_DAY + 1n) to slightly underperform for the daily limit
    // This ensures we're testing a scenario very close to, but not exceeding, the annual limit
    const time = timeElapsed + 1n;
    let rebaseAmount = (beaconBalance * annualBalanceIncreaseBPLimit * time) / (365n * ONE_DAY) / MAX_BASIS_POINTS;
    rebaseAmount = roundToGwei(rebaseAmount);

    // At this point, rebaseAmount represents a positive CL rebase that is
    // just slightly below the maximum allowed daily increase, testing the system's
    // behavior near its operational limits
    const beforeState = await readState();

    // Report
    const params = { clDiff: rebaseAmount, excludeVaultsBalances: true };

    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const hasWithdrawals = amountOfETHLocked != 0;
    const stakingModulesCount = await stakingRouter.getStakingModulesCount();
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");

    const feeDistributionTransfer = ctx.flags.withCSM ? 1n : 0n;

    // Magic numbers here: 2 – burner and treasury, 1 – only treasury
    expect(transferSharesEvents.length).to.equal(
      (hasWithdrawals ? 2n : 1n) + stakingModulesCount + feeDistributionTransfer,
      "Expected transfer of shares to DAO and staking modules",
    );

    log.debug("Staking modules count", { stakingModulesCount });

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .filter(({ args }) => args.from === ZeroAddress) // only minted shares
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent[0].args.sharesMintedAsFees).to.equal(
      mintedSharesSum,
      "TokenRebased: sharesMintedAsFee mismatch",
    );

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: 0n,
      internalEther: amountOfETHLocked * -1n + rebaseAmount,
      internalShares: sharesBurntAmount * -1n + mintedSharesSum,
      lidoBalance: amountOfETHLocked * -1n,
    });

    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");

    const ethDistributedEvent = ctx.getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance + rebaseAmount).to.equal(
      ethDistributedEvent[0].args.postCLBalance,
      "ETHDistributed: CL balance has not increased",
    );
  });

  it("Should account correctly if no EL rewards", async () => {
    const beforeState = await readState();

    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
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

    const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: false };
    const { reportTx } = (await report(ctx, params)) as {
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
    const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: false };
    const { reportTx } = (await report(ctx, params)) as {
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

    const elRewardsReceivedEvent = await ctx.getEvents(reportTxReceipt, "ELRewardsReceived")[0];
    expect(elRewardsReceivedEvent.args.amount).to.equal(elRewards);
  });

  it("Should account correctly EL rewards above limits", async () => {
    const { elRewardsVault } = ctx.contracts;

    const rewardsExcess = ether("10");
    const expectedRewards = await rebaseLimitWei();
    const elRewards = expectedRewards + rewardsExcess;

    await impersonate(elRewardsVault.address, elRewards);

    const beforeState = await readState();

    const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: false };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    await expectStateChanges(beforeState, {
      totalELRewardsCollected: expectedRewards,
      internalEther: expectedRewards - amountOfETHLocked,
      internalShares: 0n - sharesBurntAmount,
      lidoBalance: expectedRewards - amountOfETHLocked,
      elRewardsVaultBalance: 0n - expectedRewards,
    });

    const elRewardsReceivedEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
    expect(elRewardsReceivedEvent.args.amount).to.equal(expectedRewards);
  });

  it("Should account correctly with no elRewards and no withdrawals accounted for", async () => {
    const beforeState = await readState();

    // Report
    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
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
    const { withdrawalVault, stakingRouter } = ctx.contracts;
    const withdrawals = await rebaseLimitWei();
    await impersonate(withdrawalVault.address, withdrawals);

    const beforeState = await readState();

    // Report
    const params = { clDiff: 0n, reportElVault: false, reportWithdrawalsVault: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const hasWithdrawals = amountOfETHLocked != 0;
    const stakingModulesCount = await stakingRouter.getStakingModulesCount();
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");

    const feeDistributionTransfer = ctx.flags.withCSM ? 1n : 0n;

    // Magic numbers here: 2 – burner and treasury, 1 – only treasury
    expect(transferSharesEvents.length).to.equal(
      (hasWithdrawals ? 2n : 1n) + stakingModulesCount + feeDistributionTransfer,
      "Expected transfer of shares to DAO and staking modules",
    );

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .filter(({ args }) => args.from === ZeroAddress) // only minted shares
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const tokenRebasedEvent = getFirstEvent(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent.args.sharesMintedAsFees).to.equal(mintedSharesSum);

    await expectStateChanges(beforeState, {
      internalEther: withdrawals - amountOfETHLocked,
      internalShares: mintedSharesSum - sharesBurntAmount,
      lidoBalance: withdrawals - amountOfETHLocked,
      withdrawalVaultBalance: 0n - withdrawals,
    });

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const withdrawalsReceivedEvent = ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")[0];
    expect(withdrawalsReceivedEvent.args.amount).to.equal(withdrawals);
  });

  it("Should account correctly with withdrawals above limits", async () => {
    const { withdrawalVault, stakingRouter } = ctx.contracts;

    const expectedWithdrawals = await rebaseLimitWei();
    const withdrawalsExcess = ether("10");
    const withdrawals = expectedWithdrawals + withdrawalsExcess;

    await impersonate(withdrawalVault.address, withdrawals);

    const beforeState = await readState();

    const params = { clDiff: 0n, reportElVault: false, reportWithdrawalsVault: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const hasWithdrawals = amountOfETHLocked != 0;
    const stakingModulesCount = await stakingRouter.getStakingModulesCount();
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");
    const feeDistributionTransfer = ctx.flags.withCSM ? 1n : 0n;

    // Magic numbers here: 2 – burner and treasury, 1 – only treasury
    expect(transferSharesEvents.length).to.equal(
      (hasWithdrawals ? 2n : 1n) + stakingModulesCount + feeDistributionTransfer,
      "Expected transfer of shares to DAO and staking modules",
    );

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .filter(({ args }) => args.from === ZeroAddress) // only minted shares
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const tokenRebasedEvent = getFirstEvent(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent.args.sharesMintedAsFees).to.equal(mintedSharesSum);

    await expectStateChanges(beforeState, {
      internalEther: expectedWithdrawals - amountOfETHLocked,
      internalShares: mintedSharesSum - sharesBurntAmount,
      lidoBalance: expectedWithdrawals - amountOfETHLocked,
      withdrawalVaultBalance: 0n - expectedWithdrawals,
    });

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const withdrawalsReceivedEvent = getFirstEvent(reportTxReceipt, "WithdrawalsReceived");
    expect(withdrawalsReceivedEvent.args.amount).to.equal(expectedWithdrawals);
  });

  it("Should account correctly shares burn at limits", async () => {
    const { lido, burner, wstETH, accounting } = ctx.contracts;

    const sharesLimit = await sharesBurnLimitNoPooledEtherChanges();
    const initialBurnerBalance = await lido.sharesOf(burner.address);

    await ensureWhaleHasFunds(sharesLimit);

    const stethOfShares = await lido.getPooledEthByShares(sharesLimit);

    const wstEthSigner = await impersonate(wstETH.address, ether("1"));
    await lido.connect(wstEthSigner).approve(burner.address, stethOfShares);

    const coverShares = sharesLimit / 3n;
    const noCoverShares = sharesLimit - sharesLimit / 3n;

    const accountingSigner = await impersonate(accounting.address, ether("1"));

    const burnTx = await burner.connect(accountingSigner).requestBurnShares(wstETH.address, noCoverShares);
    const burnTxReceipt = (await burnTx.wait()) as ContractTransactionReceipt;
    const sharesBurntEvent = getFirstEvent(burnTxReceipt, "StETHBurnRequested");

    expect(sharesBurntEvent.args.amountOfShares).to.equal(noCoverShares, "StETHBurnRequested: amountOfShares mismatch");
    expect(sharesBurntEvent.args.isCover, "StETHBurnRequested: isCover mismatch").to.be.false;
    expect(await lido.sharesOf(burner.address)).to.equal(
      noCoverShares + initialBurnerBalance,
      "Burner shares mismatch",
    );

    const burnForCoverTx = await burner
      .connect(accountingSigner)
      .requestBurnSharesForCover(wstETH.address, coverShares);
    const burnForCoverTxReceipt = (await burnForCoverTx.wait()) as ContractTransactionReceipt;
    const sharesBurntForCoverEvent = getFirstEvent(burnForCoverTxReceipt, "StETHBurnRequested");

    expect(sharesBurntForCoverEvent.args.amountOfShares).to.equal(coverShares);
    expect(sharesBurntForCoverEvent.args.isCover, "StETHBurnRequested: isCover mismatch").to.be.true;

    const burnerShares = await lido.sharesOf(burner.address);
    expect(burnerShares).to.equal(sharesLimit + initialBurnerBalance, "Burner shares mismatch");

    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { sharesBurntAmount, sharesToBurn } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const burntDueToWithdrawals = sharesToBurn - (await lido.sharesOf(burner.address)) + initialBurnerBalance;
    expect(burntDueToWithdrawals).to.be.greaterThanOrEqual(0);
    expect(sharesBurntAmount - burntDueToWithdrawals).to.equal(sharesLimit, "SharesBurnt: sharesAmount mismatch");

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");
    expect(totalSharesBefore - sharesLimit).to.equal(
      (await lido.getTotalShares()) + burntDueToWithdrawals,
      "TotalShares change mismatch",
    );
  });

  it("Should account correctly shares burn above limits", async () => {
    const { lido, burner, wstETH, accounting } = ctx.contracts;

    await finalizeWQViaSubmit(ctx);

    const limit = await sharesBurnLimitNoPooledEtherChanges();
    const excess = 42n;
    const limitWithExcess = limit + excess;

    await ensureWhaleHasFunds(limitWithExcess);

    const stethOfShares = await lido.getPooledEthByShares(limitWithExcess);
    const wstEthSigner = await impersonate(wstETH.address, ether("1"));
    await lido.connect(wstEthSigner).approve(burner.address, stethOfShares);

    const coverShares = limit / 3n;
    const noCoverShares = limit - limit / 3n + excess;

    const accountingSigner = await impersonate(accounting.address, ether("1"));

    const initialBurnerBalance = await lido.sharesOf(burner.address);

    await expect(burner.connect(accountingSigner).requestBurnShares(wstETH, noCoverShares))
      .to.emit(burner, "StETHBurnRequested")
      .withArgs(false, accountingSigner, await lido.getPooledEthByShares(noCoverShares), noCoverShares);

    expect(await lido.sharesOf(burner)).to.equal(noCoverShares + initialBurnerBalance, "Burner shares mismatch");

    await expect(burner.connect(accountingSigner).requestBurnSharesForCover(wstETH, coverShares))
      .to.emit(burner, "StETHBurnRequested")
      .withArgs(true, accountingSigner, await lido.getPooledEthByShares(coverShares), coverShares);

    expect(await lido.sharesOf(burner)).to.equal(
      coverShares + noCoverShares + initialBurnerBalance,
      "Burner shares mismatch",
    );

    const internalSharesBefore = (await lido.getTotalShares()) - (await lido.getExternalShares());

    // Report
    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = await report(ctx, params);
    const reportTxReceipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const { sharesBurntAmount, sharesToBurn } = getWithdrawalParamsFromEvent(reportTxReceipt);

    const burnerShares = await lido.sharesOf(burner.address);
    const burntDueToWithdrawals = sharesToBurn - burnerShares + initialBurnerBalance + excess;

    expect(burntDueToWithdrawals).to.be.greaterThanOrEqual(0);
    expect(sharesBurntAmount - burntDueToWithdrawals).to.equal(limit, "SharesBurnt: sharesAmount mismatch");

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");

    const internalSharesAfter = (await lido.getTotalShares()) - (await lido.getExternalShares());
    expect(internalSharesBefore - limit).to.equal(
      internalSharesAfter + burntDueToWithdrawals,
      "TotalShares change mismatch",
    );

    const extraShares = await lido.sharesOf(burner.address);
    expect(extraShares).to.be.greaterThanOrEqual(excess, "Expected burner to have excess shares");

    // Second report
    const { reportTx: secondReportTx } = await report(ctx, { clDiff: 0n, excludeVaultsBalances: true });
    const secondReportTxReceipt = (await secondReportTx!.wait()) as ContractTransactionReceipt;

    const withdrawalParams = getWithdrawalParamsFromEvent(secondReportTxReceipt);
    expect(withdrawalParams.sharesBurntAmount).to.equal(extraShares, "SharesBurnt: sharesAmount mismatch");

    const burnerSharesAfter = await lido.sharesOf(burner.address);
    expect(burnerSharesAfter).to.equal(0, "Expected burner to have no shares");
  });

  it("Should account correctly overfill both vaults", async () => {
    const { withdrawalVault, elRewardsVault } = ctx.contracts;

    await finalizeWQViaSubmit(ctx);

    const limit = await rebaseLimitWei();
    const excess = limit / 2n; // 2nd report will take two halves of the excess of the limit size
    const limitWithExcess = limit + excess;

    await setBalance(withdrawalVault.address, limitWithExcess);
    await setBalance(elRewardsVault.address, limitWithExcess);

    const beforeState = await readState();

    let elVaultExcess = 0n;
    let amountOfETHLocked = 0n;
    let updatedLimit = 0n;
    {
      const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: true };
      const { reportTx } = (await report(ctx, params)) as {
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
    }
    {
      const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: true };
      const { reportTx } = (await report(ctx, params)) as {
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
    }
    {
      const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: true };
      const { reportTx } = (await report(ctx, params)) as {
        reportTx: TransactionResponse;
        extraDataTx: TransactionResponse;
      };
      const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

      expect(ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")).to.be.empty;

      const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);
      expect(elRewardsVaultBalance).to.equal(0, "Expected EL vault to be emptied");

      const rewardsEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
      expect(rewardsEvent.args.amount).to.equal(elVaultExcess, "ELRewardsReceived: amount mismatch");

      await expectStateChanges(beforeState, {
        totalELRewardsCollected: limitWithExcess,
        internalEther: limitWithExcess * 2n - amountOfETHLocked,
        lidoBalance: limitWithExcess * 2n - amountOfETHLocked,
        elRewardsVaultBalance: 0n - limitWithExcess,
      });
    }
  });
});
