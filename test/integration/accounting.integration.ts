import { expect } from "chai";
import { ContractTransactionReceipt, LogDescription, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, impersonate, ONE_GWEI, trace, updateBalance } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  finalizeWithdrawalQueue,
  getReportTimeElapsed,
  norEnsureOperators,
  report,
  sdvtEnsureOperators,
} from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const LIMITER_PRECISION_BASE = BigInt(10 ** 9);

const SHARE_RATE_PRECISION = BigInt(10 ** 27);
const ONE_DAY = 86400n;
const MAX_BASIS_POINTS = 10000n;
const AMOUNT = ether("100");
const MAX_DEPOSIT = 150n;
const CURATED_MODULE_ID = 1n;
const SIMPLE_DVT_MODULE_ID = 2n;

const ZERO_HASH = new Uint8Array(32).fill(0);

describe("Accounting", () => {
  let ctx: ProtocolContext;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, ethHolder] = await ethers.getSigners();

    snapshot = await Snapshot.take();

    const { lido, depositSecurityModule } = ctx.contracts;

    await finalizeWithdrawalQueue(ctx, stEthHolder, ethHolder);

    await norEnsureOperators(ctx, 3n, 5n);
    await sdvtEnsureOperators(ctx, 3n, 5n);

    // Deposit node operators
    const dsmSigner = await impersonate(depositSecurityModule.address, AMOUNT);
    await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
    await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, SIMPLE_DVT_MODULE_ID, ZERO_HASH);

    await report(ctx, {
      clDiff: ether("32") * 6n, // 32 ETH * (3 + 3) validators
      clAppearedValidators: 6n,
      excludeVaultsBalances: true,
    });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot)); // Rollback to the initial state pre deployment

  const getFirstEvent = (receipt: ContractTransactionReceipt, eventName: string) => {
    const events = ctx.getEvents(receipt, eventName);
    expect(events.length).to.be.greaterThan(0);
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
    const totalPooledEther = await lido.getTotalPooledEther();

    expect(maxPositiveTokeRebase).to.be.greaterThanOrEqual(0);
    expect(totalPooledEther).to.be.greaterThanOrEqual(0);

    return (maxPositiveTokeRebase * totalPooledEther) / LIMITER_PRECISION_BASE;
  };

  const getWithdrawalParams = (tx: ContractTransactionReceipt) => {
    const withdrawalsFinalized = ctx.getEvents(tx, "WithdrawalsFinalized");
    const amountOfETHLocked = withdrawalsFinalized.length > 0 ? withdrawalsFinalized[0].args.amountOfETHLocked : 0n;
    const sharesToBurn = withdrawalsFinalized.length > 0 ? withdrawalsFinalized[0].args.sharesToBurn : 0n;

    const sharesBurnt = ctx.getEvents(tx, "SharesBurnt");
    const sharesBurntAmount = sharesBurnt.length > 0 ? sharesBurnt[0].args.sharesAmount : 0n;

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
    const rebaseLimit = await ctx.contracts.oracleReportSanityChecker.getMaxPositiveTokenRebase();
    const rebaseLimitPlus1 = rebaseLimit + LIMITER_PRECISION_BASE;

    return ((await ctx.contracts.lido.getTotalShares()) * rebaseLimit) / rebaseLimitPlus1;
  };

  // Ensure the whale account has enough shares, e.g. on scratch deployments
  async function ensureWhaleHasFunds() {
    const { lido, wstETH } = ctx.contracts;
    if (!(await lido.sharesOf(wstETH.address))) {
      const wstEthSigner = await impersonate(wstETH.address, ether("10001"));
      const submitTx = await lido.connect(wstEthSigner).submit(ZeroAddress, { value: ether("10000") });
      await trace("lido.submit", submitTx);
    }
  }

  // Helper function to finalize all requests
  async function ensureRequestsFinalized() {
    const { lido, withdrawalQueue } = ctx.contracts;

    await setBalance(ethHolder.address, ether("1000000"));

    while ((await withdrawalQueue.getLastRequestId()) != (await withdrawalQueue.getLastFinalizedRequestId())) {
      await report(ctx);
      const submitTx = await lido.connect(ethHolder).submit(ZeroAddress, { value: ether("10000") });
      await trace("lido.submit", submitTx);
    }
  }

  it("Should reverts report on sanity checks", async () => {
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
    const { lido, accountingOracle } = ctx.contracts;

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const ethBalanceBefore = await ethers.provider.getBalance(lido.address);

    // Report
    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased");
    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateBefore).to.be.lessThanOrEqual(sharesRateAfter);

    const ethBalanceAfter = await ethers.provider.getBalance(lido.address);
    expect(ethBalanceBefore).to.equal(ethBalanceAfter + amountOfETHLocked);
  });

  it("Should account correctly with negative CL rebase", async () => {
    const { lido, accountingOracle } = ctx.contracts;

    const REBASE_AMOUNT = ether("-1"); // Must be enough to cover the fees

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const params = { clDiff: REBASE_AMOUNT, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + REBASE_AMOUNT).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased");
    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateAfter).to.be.lessThan(sharesRateBefore);

    const ethDistributedEvent = ctx.getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance + REBASE_AMOUNT).to.equal(
      ethDistributedEvent[0].args.postCLBalance,
      "ETHDistributed: CL balance differs from expected",
    );
  });

  it("Should account correctly with positive CL rebase close to the limits", async () => {
    const { lido, accountingOracle, oracleReportSanityChecker, stakingRouter } = ctx.contracts;

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
    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const params = { clDiff: rebaseAmount, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + rebaseAmount).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const hasWithdrawals = amountOfETHLocked != 0;
    const stakingModulesCount = await stakingRouter.getStakingModulesCount();
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const treasurySharesAsFees = transferSharesEvents[transferSharesEvents.length - 1]; // always the last one

    // if withdrawals processed goes after burner, if no withdrawals processed goes first
    const norSharesAsFees = transferSharesEvents[hasWithdrawals ? 1 : 0];

    // if withdrawals processed goes after burner and NOR, if no withdrawals processed goes after NOR
    const sdvtSharesAsFees = transferSharesEvents[hasWithdrawals ? 2 : 1];

    expect(transferSharesEvents.length).to.equal(
      hasWithdrawals ? 2n : 1n + stakingModulesCount,
      "Expected transfer of shares to DAO and staking modules",
    );

    // shares minted to DAO and NodeOperatorsRegistry should be equal
    const norStats = await stakingRouter.getStakingModule(CURATED_MODULE_ID);
    const norShare = norSharesAsFees.args.sharesValue;
    const sdvtShare = sdvtSharesAsFees?.args.sharesValue || 0n;
    // nor_treasury_fee = nor_share / share_pct * treasury_pct
    const norTreasuryFee = (((norShare * 10000n) / norStats.stakingModuleFee) * norStats.treasuryFee) / 10000n;

    // if the simple DVT module is not present, check the shares minted to treasury and DAO are equal
    if (!sdvtSharesAsFees) {
      expect(norTreasuryFee).to.approximately(
        treasurySharesAsFees.args.sharesValue,
        100,
        "Shares minted to DAO and NodeOperatorsRegistry mismatch",
      );
    }

    // if the simple DVT module is present, check the shares minted to it and treasury are equal
    if (sdvtSharesAsFees) {
      const sdvtStats = await stakingRouter.getStakingModule(SIMPLE_DVT_MODULE_ID);
      const sdvtTreasuryFee = (((sdvtShare * 10000n) / sdvtStats.stakingModuleFee) * sdvtStats.treasuryFee) / 10000n;

      expect(norTreasuryFee + sdvtTreasuryFee).to.approximately(
        treasurySharesAsFees.args.sharesValue,
        100,
        "Shares minted to DAO and sDVT mismatch",
      );
    }

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent[0].args.sharesMintedAsFees).to.equal(
      mintedSharesSum,
      "TokenRebased: sharesMintedAsFee mismatch",
    );

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore + mintedSharesSum).to.equal(
      totalSharesAfter + sharesBurntAmount,
      "TotalShares change mismatch",
    );

    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");

    const ethDistributedEvent = ctx.getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance + rebaseAmount).to.equal(
      ethDistributedEvent[0].args.postCLBalance,
      "ETHDistributed: CL balance has not increased",
    );
  });

  it("Should account correctly if no EL rewards", async () => {
    const { lido, accountingOracle } = ctx.contracts;

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const ethBalanceBefore = await ethers.provider.getBalance(lido.address);

    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const ethBalanceAfter = await ethers.provider.getBalance(lido.address);
    expect(ethBalanceBefore).to.equal(ethBalanceAfter + amountOfETHLocked);

    expect(ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")).to.be.empty;
    expect(ctx.getEvents(reportTxReceipt, "ELRewardsReceived")).to.be.empty;
  });

  it("Should account correctly normal EL rewards", async () => {
    const { lido, accountingOracle, elRewardsVault } = ctx.contracts;

    await updateBalance(elRewardsVault.address, ether("1"));

    const elRewards = await ethers.provider.getBalance(elRewardsVault.address);
    expect(elRewards).to.be.greaterThan(0, "Expected EL vault to be non-empty");

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const lidoBalanceBefore = await ethers.provider.getBalance(lido.address);

    const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: false };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore + elRewards).to.equal(totalELRewardsCollectedAfter);

    const elRewardsReceivedEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
    expect(elRewardsReceivedEvent.args.amount).to.equal(elRewards);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + elRewards).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const lidoBalanceAfter = await ethers.provider.getBalance(lido.address);
    expect(lidoBalanceBefore + elRewards).to.equal(lidoBalanceAfter + amountOfETHLocked);

    const elVaultBalanceAfter = await ethers.provider.getBalance(elRewardsVault.address);
    expect(elVaultBalanceAfter).to.equal(0, "Expected EL vault to be empty");
  });

  it("Should account correctly EL rewards at limits", async () => {
    const { lido, accountingOracle, elRewardsVault } = ctx.contracts;

    const elRewards = await rebaseLimitWei();

    await impersonate(elRewardsVault.address, elRewards);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const lidoBalanceBefore = await ethers.provider.getBalance(lido.address);

    // Report
    const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: false };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore + elRewards).to.equal(totalELRewardsCollectedAfter);

    const elRewardsReceivedEvent = await ctx.getEvents(reportTxReceipt, "ELRewardsReceived")[0];
    expect(elRewardsReceivedEvent.args.amount).to.equal(elRewards);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + elRewards).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const lidoBalanceAfter = await ethers.provider.getBalance(lido.address);
    expect(lidoBalanceBefore + elRewards).to.equal(lidoBalanceAfter + amountOfETHLocked);

    const elVaultBalanceAfter = await ethers.provider.getBalance(elRewardsVault.address);
    expect(elVaultBalanceAfter).to.equal(0, "Expected EL vault to be empty");
  });

  it("Should account correctly EL rewards above limits", async () => {
    const { lido, accountingOracle, elRewardsVault } = ctx.contracts;

    const rewardsExcess = ether("10");
    const expectedRewards = await rebaseLimitWei();
    const elRewards = expectedRewards + rewardsExcess;

    await impersonate(elRewardsVault.address, elRewards);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const lidoBalanceBefore = await ethers.provider.getBalance(lido.address);

    const params = { clDiff: 0n, reportElVault: true, reportWithdrawalsVault: false };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore + expectedRewards).to.equal(
      totalELRewardsCollectedAfter,
      "TotalELRewardsCollected change mismatch",
    );

    const elRewardsReceivedEvent = getFirstEvent(reportTxReceipt, "ELRewardsReceived");
    expect(elRewardsReceivedEvent.args.amount).to.equal(expectedRewards);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + expectedRewards).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const lidoBalanceAfter = await ethers.provider.getBalance(lido.address);
    expect(lidoBalanceBefore + expectedRewards).equal(lidoBalanceAfter + amountOfETHLocked);

    const elVaultBalanceAfter = await ethers.provider.getBalance(elRewardsVault.address);
    expect(elVaultBalanceAfter).to.equal(rewardsExcess, "Expected EL vault to be filled with excess rewards");
  });

  it("Should account correctly with no withdrawals", async () => {
    const { lido, accountingOracle } = ctx.contracts;

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const lidoBalanceBefore = await ethers.provider.getBalance(lido.address);

    // Report
    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurntAmount);

    const lidoBalanceAfter = await ethers.provider.getBalance(lido.address);
    expect(lidoBalanceBefore).to.equal(lidoBalanceAfter + amountOfETHLocked);

    expect(ctx.getEvents(reportTxReceipt, "WithdrawalsReceived").length).be.equal(0);
    expect(ctx.getEvents(reportTxReceipt, "ELRewardsReceived").length).be.equal(0);
  });

  it("Should account correctly with withdrawals at limits", async () => {
    const { lido, accountingOracle, withdrawalVault, stakingRouter } = ctx.contracts;

    const withdrawals = await rebaseLimitWei();

    await impersonate(withdrawalVault.address, withdrawals);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const params = { clDiff: 0n, reportElVault: false, reportWithdrawalsVault: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + withdrawals).to.equal(
      totalPooledEtherAfter + amountOfETHLocked,
      "TotalPooledEther change mismatch",
    );

    const hasWithdrawals = amountOfETHLocked != 0;
    const stakingModulesCount = await stakingRouter.getStakingModulesCount();
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const treasurySharesAsFees = transferSharesEvents[transferSharesEvents.length - 1]; // always the last one

    // if withdrawals processed goes after burner, if no withdrawals processed goes first
    const norSharesAsFees = transferSharesEvents[hasWithdrawals ? 1 : 0];

    // if withdrawals processed goes after burner and NOR, if no withdrawals processed goes after NOR
    const sdvtSharesAsFees = transferSharesEvents[hasWithdrawals ? 2 : 1];

    expect(transferSharesEvents.length).to.equal(
      hasWithdrawals ? 2n : 1n + stakingModulesCount,
      "Expected transfer of shares to DAO and staking modules",
    );

    // shares minted to DAO and NodeOperatorsRegistry should be equal
    const norStats = await stakingRouter.getStakingModule(CURATED_MODULE_ID);
    const norShare = norSharesAsFees.args.sharesValue;
    const sdvtShare = sdvtSharesAsFees?.args.sharesValue || 0n;
    // nor_treasury_fee = nor_share / share_pct * treasury_pct
    const norTreasuryFee = (((norShare * 10000n) / norStats.stakingModuleFee) * norStats.treasuryFee) / 10000n;

    // if the simple DVT module is not present, check the shares minted to treasury and DAO are equal
    if (!sdvtSharesAsFees) {
      expect(norTreasuryFee).to.approximately(
        treasurySharesAsFees.args.sharesValue,
        100,
        "Shares minted to DAO and NodeOperatorsRegistry mismatch",
      );
    }

    // if the simple DVT module is present, check the shares minted to it and treasury are equal
    if (sdvtSharesAsFees) {
      const sdvtStats = await stakingRouter.getStakingModule(SIMPLE_DVT_MODULE_ID);
      const sdvtTreasuryFee = (((sdvtShare * 10000n) / sdvtStats.stakingModuleFee) * sdvtStats.treasuryFee) / 10000n;

      expect(norTreasuryFee + sdvtTreasuryFee).to.approximately(
        treasurySharesAsFees.args.sharesValue,
        100,
        "Shares minted to DAO and sDVT mismatch",
      );
    }

    const tokenRebasedEvent = getFirstEvent(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent.args.sharesMintedAsFees).to.equal(mintedSharesSum);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore + mintedSharesSum).to.equal(totalSharesAfter + sharesBurntAmount);

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const withdrawalsReceivedEvent = ctx.getEvents(reportTxReceipt, "WithdrawalsReceived")[0];
    expect(withdrawalsReceivedEvent.args.amount).to.equal(withdrawals);

    const withdrawalVaultBalanceAfter = await ethers.provider.getBalance(withdrawalVault.address);
    expect(withdrawalVaultBalanceAfter).to.equal(0, "Expected withdrawals vault to be empty");
  });

  it("Should account correctly with withdrawals above limits", async () => {
    const { lido, accountingOracle, withdrawalVault, stakingRouter } = ctx.contracts;

    const expectedWithdrawals = await rebaseLimitWei();
    const withdrawalsExcess = ether("10");
    const withdrawals = expectedWithdrawals + withdrawalsExcess;

    await impersonate(withdrawalVault.address, withdrawals);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();

    const params = { clDiff: 0n, reportElVault: false, reportWithdrawalsVault: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { amountOfETHLocked, sharesBurntAmount } = getWithdrawalParams(reportTxReceipt);

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(
      lastProcessingRefSlotAfter,
      "LastProcessingRefSlot should be updated",
    );

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + expectedWithdrawals).to.equal(totalPooledEtherAfter + amountOfETHLocked);

    const hasWithdrawals = amountOfETHLocked != 0;
    const stakingModulesCount = await stakingRouter.getStakingModulesCount();
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");

    const mintedSharesSum = transferSharesEvents
      .slice(hasWithdrawals ? 1 : 0) // skip burner if withdrawals processed
      .reduce((acc, { args }) => acc + args.sharesValue, 0n);

    const treasurySharesAsFees = transferSharesEvents[transferSharesEvents.length - 1]; // always the last one

    // if withdrawals processed goes after burner, if no withdrawals processed goes first
    const norSharesAsFees = transferSharesEvents[hasWithdrawals ? 1 : 0];

    // if withdrawals processed goes after burner and NOR, if no withdrawals processed goes after NOR
    const sdvtSharesAsFees = transferSharesEvents[hasWithdrawals ? 2 : 1];

    expect(transferSharesEvents.length).to.equal(
      hasWithdrawals ? 2n : 1n + stakingModulesCount,
      "Expected transfer of shares to DAO and staking modules",
    );

    // shares minted to DAO and NodeOperatorsRegistry should be equal
    const norStats = await stakingRouter.getStakingModule(CURATED_MODULE_ID);
    const norShare = norSharesAsFees.args.sharesValue;
    const sdvtShare = sdvtSharesAsFees?.args.sharesValue || 0n;
    // nor_treasury_fee = nor_share / share_pct * treasury_pct
    const norTreasuryFee = (((norShare * 10000n) / norStats.stakingModuleFee) * norStats.treasuryFee) / 10000n;

    // if the simple DVT module is not present, check the shares minted to treasury and DAO are equal
    if (!sdvtSharesAsFees) {
      expect(norTreasuryFee).to.approximately(
        treasurySharesAsFees.args.sharesValue,
        100,
        "Shares minted to DAO and NodeOperatorsRegistry mismatch",
      );
    }

    // if the simple DVT module is present, check the shares minted to it and treasury are equal
    if (sdvtSharesAsFees) {
      const sdvtStats = await stakingRouter.getStakingModule(SIMPLE_DVT_MODULE_ID);
      const sdvtTreasuryFee = (((sdvtShare * 10000n) / sdvtStats.stakingModuleFee) * sdvtStats.treasuryFee) / 10000n;

      expect(norTreasuryFee + sdvtTreasuryFee).to.approximately(
        treasurySharesAsFees.args.sharesValue,
        100,
        "Shares minted to DAO and sDVT mismatch",
      );
    }

    const tokenRebasedEvent = getFirstEvent(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent.args.sharesMintedAsFees).to.equal(mintedSharesSum);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore + mintedSharesSum).to.equal(totalSharesAfter + sharesBurntAmount);

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const withdrawalsReceivedEvent = getFirstEvent(reportTxReceipt, "WithdrawalsReceived");
    expect(withdrawalsReceivedEvent.args.amount).to.equal(expectedWithdrawals);

    const withdrawalVaultBalanceAfter = await ethers.provider.getBalance(withdrawalVault.address);
    expect(withdrawalVaultBalanceAfter).to.equal(
      withdrawalsExcess,
      "Expected withdrawal vault to be filled with excess rewards",
    );
  });

  it("Should account correctly shares burn at limits", async () => {
    const { lido, burner, wstETH } = ctx.contracts;

    const sharesLimit = await sharesBurnLimitNoPooledEtherChanges();
    const initialBurnerBalance = await lido.sharesOf(burner.address);

    await ensureWhaleHasFunds();

    expect(await lido.sharesOf(wstETH.address)).to.be.greaterThan(sharesLimit, "Not enough shares on whale account");

    const stethOfShares = await lido.getPooledEthByShares(sharesLimit);

    const wstEthSigner = await impersonate(wstETH.address, ether("1"));
    const approveTx = await lido.connect(wstEthSigner).approve(burner.address, stethOfShares);
    await trace("lido.approve", approveTx);

    const coverShares = sharesLimit / 3n;
    const noCoverShares = sharesLimit - sharesLimit / 3n;

    const lidoSigner = await impersonate(lido.address);

    const burnTx = await burner.connect(lidoSigner).requestBurnShares(wstETH.address, noCoverShares);
    const burnTxReceipt = await trace<ContractTransactionReceipt>("burner.requestBurnShares", burnTx);
    const sharesBurntEvent = getFirstEvent(burnTxReceipt, "StETHBurnRequested");

    expect(sharesBurntEvent.args.amountOfShares).to.equal(noCoverShares, "StETHBurnRequested: amountOfShares mismatch");
    expect(sharesBurntEvent.args.isCover, "StETHBurnRequested: isCover mismatch").to.be.false;
    expect(await lido.sharesOf(burner.address)).to.equal(
      noCoverShares + initialBurnerBalance,
      "Burner shares mismatch",
    );

    const burnForCoverTx = await burner.connect(lidoSigner).requestBurnSharesForCover(wstETH.address, coverShares);
    const burnForCoverTxReceipt = await trace<ContractTransactionReceipt>(
      "burner.requestBurnSharesForCover",
      burnForCoverTx,
    );
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
    const { sharesBurntAmount, sharesToBurn } = getWithdrawalParams(reportTxReceipt);

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
    const { lido, burner, wstETH } = ctx.contracts;

    await ensureRequestsFinalized();

    await ensureWhaleHasFunds();

    const limit = await sharesBurnLimitNoPooledEtherChanges();
    const excess = 42n;
    const limitWithExcess = limit + excess;

    const initialBurnerBalance = await lido.sharesOf(burner.address);
    expect(initialBurnerBalance).to.equal(0);
    expect(await lido.sharesOf(wstETH.address)).to.be.greaterThan(
      limitWithExcess,
      "Not enough shares on whale account",
    );

    const stethOfShares = await lido.getPooledEthByShares(limitWithExcess);

    const wstEthSigner = await impersonate(wstETH.address, ether("1"));
    const approveTx = await lido.connect(wstEthSigner).approve(burner.address, stethOfShares);
    await trace("lido.approve", approveTx);

    const coverShares = limit / 3n;
    const noCoverShares = limit - limit / 3n + excess;

    const lidoSigner = await impersonate(lido.address);

    const burnTx = await burner.connect(lidoSigner).requestBurnShares(wstETH.address, noCoverShares);
    const burnTxReceipt = await trace<ContractTransactionReceipt>("burner.requestBurnShares", burnTx);
    const sharesBurntEvent = getFirstEvent(burnTxReceipt, "StETHBurnRequested");

    expect(sharesBurntEvent.args.amountOfShares).to.equal(noCoverShares, "StETHBurnRequested: amountOfShares mismatch");
    expect(sharesBurntEvent.args.isCover, "StETHBurnRequested: isCover mismatch").to.be.false;
    expect(await lido.sharesOf(burner.address)).to.equal(
      noCoverShares + initialBurnerBalance,
      "Burner shares mismatch",
    );

    const burnForCoverRequest = await burner.connect(lidoSigner).requestBurnSharesForCover(wstETH.address, coverShares);
    const burnForCoverRequestReceipt = (await burnForCoverRequest.wait()) as ContractTransactionReceipt;
    const sharesBurntForCoverEvent = getFirstEvent(burnForCoverRequestReceipt, "StETHBurnRequested");

    expect(sharesBurntForCoverEvent.args.amountOfShares).to.equal(
      coverShares,
      "StETHBurnRequested: amountOfShares mismatch",
    );
    expect(sharesBurntForCoverEvent.args.isCover, "StETHBurnRequested: isCover mismatch").to.be.true;
    expect(await lido.sharesOf(burner.address)).to.equal(
      limitWithExcess + initialBurnerBalance,
      "Burner shares mismatch",
    );

    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const params = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx } = (await report(ctx, params)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const { sharesBurntAmount, sharesToBurn } = getWithdrawalParams(reportTxReceipt);
    const burnerShares = await lido.sharesOf(burner.address);
    const burntDueToWithdrawals = sharesToBurn - burnerShares + initialBurnerBalance + excess;
    expect(burntDueToWithdrawals).to.be.greaterThanOrEqual(0);
    expect(sharesBurntAmount - burntDueToWithdrawals).to.equal(limit, "SharesBurnt: sharesAmount mismatch");

    const [sharesRateBefore, sharesRateAfter] = sharesRateFromEvent(reportTxReceipt);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore, "Shares rate has not increased");

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore - limit).to.equal(totalSharesAfter + burntDueToWithdrawals, "TotalShares change mismatch");

    const extraShares = await lido.sharesOf(burner.address);
    expect(extraShares).to.be.greaterThanOrEqual(excess, "Expected burner to have excess shares");

    // Second report
    const secondReportParams = { clDiff: 0n, excludeVaultsBalances: true };
    const { reportTx: secondReportTx } = (await report(ctx, secondReportParams)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    const secondReportTxReceipt = (await secondReportTx.wait()) as ContractTransactionReceipt;

    const withdrawalParams = getWithdrawalParams(secondReportTxReceipt);
    expect(withdrawalParams.sharesBurntAmount).to.equal(extraShares, "SharesBurnt: sharesAmount mismatch");

    const burnerSharesAfter = await lido.sharesOf(burner.address);
    expect(burnerSharesAfter).to.equal(0, "Expected burner to have no shares");
  });

  it("Should account correctly overfill both vaults", async () => {
    const { lido, withdrawalVault, elRewardsVault } = ctx.contracts;

    await ensureRequestsFinalized();

    const limit = await rebaseLimitWei();
    const excess = ether("10");
    const limitWithExcess = limit + excess;

    await setBalance(withdrawalVault.address, limitWithExcess);
    await setBalance(elRewardsVault.address, limitWithExcess);

    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const ethBalanceBefore = await ethers.provider.getBalance(lido.address);

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

      amountOfETHLocked = getWithdrawalParams(reportTxReceipt).amountOfETHLocked;

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

      const totalELRewardsCollected = totalELRewardsCollectedBefore + limitWithExcess;
      const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
      expect(totalELRewardsCollected).to.equal(totalELRewardsCollectedAfter, "TotalELRewardsCollected change mismatch");

      const expectedTotalPooledEther = totalPooledEtherBefore + limitWithExcess * 2n;
      const totalPooledEtherAfter = await lido.getTotalPooledEther();
      expect(expectedTotalPooledEther).to.equal(
        totalPooledEtherAfter + amountOfETHLocked,
        "TotalPooledEther change mismatch",
      );

      const expectedEthBalance = ethBalanceBefore + limitWithExcess * 2n;
      const ethBalanceAfter = await ethers.provider.getBalance(lido.address);
      expect(expectedEthBalance).to.equal(ethBalanceAfter + amountOfETHLocked, "Lido ETH balance change mismatch");
    }
  });
});
