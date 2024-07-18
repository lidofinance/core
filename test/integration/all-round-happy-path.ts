import { expect } from "chai";
import { ContractTransactionReceipt, Result, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { batch, ether, findEventsWithInterfaces, impersonate, log, trace } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { ensureSDVTOperators, oracleReport, unpauseStaking, unpauseWithdrawalQueue } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const AMOUNT = ether("100");
const MAX_DEPOSIT = 150n;
const CURATED_MODULE_ID = 1n;
const SIMPLE_DVT_MODULE_ID = 2n;

const ZERO_HASH = new Uint8Array(32).fill(0);

describe("Protocol", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let uncountedStETHShares: bigint;
  let amountWithRewards: bigint;
  let requestIds: bigint[];
  let lockedEtherAmountBeforeFinalization: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    const signers = await ethers.getSigners();

    [ethHolder, stEthHolder, stranger] = await Promise.all([
      impersonate(signers[0].address, ether("1000000")),
      impersonate(signers[1].address, ether("1000000")),
      impersonate(signers[2].address, ether("1000000")),
    ]);

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  const getEvents = (receipt: ContractTransactionReceipt, eventName: string) => {
    return findEventsWithInterfaces(receipt, eventName, ctx.interfaces);
  };

  const submitStake = async (amount: bigint, wallet: HardhatEthersSigner) => {
    const { lido } = ctx.contracts;
    const tx = await lido.connect(wallet).submit(ZeroAddress, { value: amount });
    await trace("lido.submit", tx);
  };

  const getBalances = async (wallet: HardhatEthersSigner) => {
    const { lido } = ctx.contracts;
    return batch({
      ETH: ethers.provider.getBalance(wallet),
      stETH: lido.balanceOf(wallet),
    });
  };

  it("Should be unpaused", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    await unpauseStaking(ctx);
    await unpauseWithdrawalQueue(ctx);

    expect(await lido.isStakingPaused()).to.be.false;
    expect(await withdrawalQueue.isPaused()).to.be.false;
  });

  it("Should be able to finalize the withdrawal queue", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const stEthHolderAmount = ether("10000");
    const tx = await stEthHolder.sendTransaction({ to: lido.address, value: stEthHolderAmount });
    await trace("stEthHolder.sendTransaction", tx);

    // Note: when using tracer it stops on promise.all concurrency, and slows down the test
    const getRequests = async () => {
      const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
      const lastRequestId = await withdrawalQueue.getLastRequestId();

      return { lastFinalizedRequestId, lastRequestId };
    };

    let { lastFinalizedRequestId, lastRequestId } = await getRequests();

    while (lastFinalizedRequestId != lastRequestId) {
      await oracleReport(ctx);

      ({ lastFinalizedRequestId, lastRequestId } = await getRequests());

      log.debug("Withdrawal queue", {
        "Last finalized request ID": lastFinalizedRequestId,
        "Last request ID": lastRequestId,
      });

      await submitStake(ether("10000"), ethHolder);
    }

    await submitStake(ether("10000"), ethHolder);

    // Will be used in finalization part
    uncountedStETHShares = await lido.sharesOf(withdrawalQueue.address);

    const approveTx = await lido.connect(stEthHolder).approve(withdrawalQueue.address, 1000n);
    await trace("lido.approve", approveTx);

    const requestWithdrawalsTx = await withdrawalQueue.connect(stEthHolder).requestWithdrawals([1000n], stEthHolder);
    await trace("withdrawalQueue.requestWithdrawals", requestWithdrawalsTx);
  });

  it("Should have some Simple DVT operators", async () => {
    await ensureSDVTOperators(ctx, 3n, 5n);

    expect(await ctx.contracts.sdvt.getNodeOperatorsCount()).to.be.least(3n);
  });

  it("Should allow ETH holders to submit stake", async () => {
    const { lido } = ctx.contracts;

    const strangerBalancesBeforeSubmit = await getBalances(stranger);

    log.debug("Stranger before submit", {
      address: stranger.address,
      ETH: ethers.formatEther(strangerBalancesBeforeSubmit.ETH),
      stETH: ethers.formatEther(strangerBalancesBeforeSubmit.stETH),
    });

    expect(strangerBalancesBeforeSubmit.stETH).to.be.equal(0n, "stETH balance before submit");
    expect(strangerBalancesBeforeSubmit.ETH).to.be.equal(ether("1000000"), "ETH balance before submit");

    const stakeLimitInfoBefore = await lido.getStakeLimitFullInfo();
    const growthPerBlock = stakeLimitInfoBefore.maxStakeLimit / stakeLimitInfoBefore.maxStakeLimitGrowthBlocks;

    const totalSupplyBeforeSubmit = await lido.totalSupply();
    const bufferedEtherBeforeSubmit = await lido.getBufferedEther();
    const stakingLimitBeforeSubmit = await lido.getCurrentStakeLimit();
    const heightBeforeSubmit = await ethers.provider.getBlockNumber();

    log.debug("Before submit", {
      "Chain height": heightBeforeSubmit,
      "Growth per block": ethers.formatEther(growthPerBlock),
      "Total supply": ethers.formatEther(totalSupplyBeforeSubmit),
      "Buffered ether": ethers.formatEther(bufferedEtherBeforeSubmit),
      "Staking limit": ethers.formatEther(stakingLimitBeforeSubmit),
    });

    const tx = await lido.connect(stranger).submit(ZeroAddress, { value: AMOUNT });
    const receipt = await trace<ContractTransactionReceipt>("lido.submit", tx);

    expect(receipt).not.to.be.null;

    const strangerBalancesAfterSubmit = await getBalances(stranger);

    log.debug("Stranger after submit", {
      address: stranger.address,
      ETH: ethers.formatEther(strangerBalancesAfterSubmit.ETH),
      stETH: ethers.formatEther(strangerBalancesAfterSubmit.stETH),
    });

    const spendEth = AMOUNT + receipt.gasUsed * receipt.gasPrice;

    expect(strangerBalancesAfterSubmit.stETH).to.be.approximately(
      strangerBalancesBeforeSubmit.stETH + AMOUNT,
      10n,
      "stETH balance after submit",
    );
    expect(strangerBalancesAfterSubmit.ETH).to.be.approximately(
      strangerBalancesBeforeSubmit.ETH - spendEth,
      10n,
      "ETH balance after submit",
    );

    const submittedEvent = getEvents(receipt, "Submitted")[0];
    const transferSharesEvent = getEvents(receipt, "TransferShares")[0];
    const sharesToBeMinted = await lido.getSharesByPooledEth(AMOUNT);
    const mintedShares = await lido.sharesOf(stranger);

    expect(submittedEvent).not.to.be.undefined;
    expect(submittedEvent.args[0]).to.be.equal(stranger, "Submitted event sender");
    expect(submittedEvent.args[1]).to.be.equal(AMOUNT, "Submitted event amount");
    expect(submittedEvent.args[2]).to.be.equal(ZeroAddress, "Submitted event referral");

    expect(transferSharesEvent).not.to.be.undefined;
    expect(transferSharesEvent.args[0]).to.be.equal(ZeroAddress, "TransferShares event sender");
    expect(transferSharesEvent.args[1]).to.be.equal(stranger, "TransferShares event recipient");
    expect(transferSharesEvent.args[2]).to.be.approximately(sharesToBeMinted, 10n, "TransferShares event amount");

    expect(mintedShares).to.be.equal(sharesToBeMinted, "Minted shares");

    const totalSupplyAfterSubmit = await lido.totalSupply();
    const bufferedEtherAfterSubmit = await lido.getBufferedEther();
    const stakingLimitAfterSubmit = await lido.getCurrentStakeLimit();

    expect(totalSupplyAfterSubmit).to.be.equal(totalSupplyBeforeSubmit + AMOUNT, "Total supply after submit");
    expect(bufferedEtherAfterSubmit).to.be.equal(bufferedEtherBeforeSubmit + AMOUNT, "Buffered ether after submit");

    if (stakingLimitBeforeSubmit >= stakeLimitInfoBefore.maxStakeLimit - growthPerBlock) {
      expect(stakingLimitAfterSubmit).to.be.equal(
        stakingLimitBeforeSubmit - AMOUNT,
        "Staking limit after submit without growth",
      );
    } else {
      expect(stakingLimitAfterSubmit).to.be.equal(
        stakingLimitBeforeSubmit - AMOUNT + growthPerBlock,
        "Staking limit after submit",
      );
    }
  });

  it("Should deposit ETH to node operators", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const { depositSecurityModule } = ctx.contracts;
    const { depositedValidators: depositedValidatorsBeforeDeposit } = await lido.getBeaconStat();
    const withdrawalsUninitializedStETH = await withdrawalQueue.unfinalizedStETH();
    const depositableEther = await lido.getDepositableEther();
    const bufferedEtherBeforeDeposit = await lido.getBufferedEther();

    const expectedDepositableEther = bufferedEtherBeforeDeposit - withdrawalsUninitializedStETH;

    expect(depositableEther).to.be.equal(expectedDepositableEther, "Depositable ether");

    log.debug("Depositable ether", {
      "Buffered ether": ethers.formatEther(bufferedEtherBeforeDeposit),
      "Withdrawals uninitialized stETH": ethers.formatEther(withdrawalsUninitializedStETH),
      "Depositable ether": ethers.formatEther(depositableEther),
    });

    const dsmSigner = await impersonate(depositSecurityModule.address, ether("100"));

    const depositNorTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
    const depositNorReceipt = await trace<ContractTransactionReceipt>("lido.deposit (Curated Module)", depositNorTx);

    const depositSdvtTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, SIMPLE_DVT_MODULE_ID, ZERO_HASH);
    const depositSdvtReceipt = await trace<ContractTransactionReceipt>("lido.deposit (Simple DVT)", depositSdvtTx);

    const bufferedEtherAfterDeposit = await lido.getBufferedEther();

    const unbufferedEventNor = getEvents(depositNorReceipt, "Unbuffered")[0];
    const unbufferedEventSdvt = getEvents(depositSdvtReceipt, "Unbuffered")[0];
    const depositedValidatorsChangedEventSdvt = getEvents(depositSdvtReceipt, "DepositedValidatorsChanged")[0];

    const unbufferedAmountNor = unbufferedEventNor.args[0];
    const unbufferedAmountSdvt = unbufferedEventSdvt.args[0];
    const newValidatorsCountSdvt = depositedValidatorsChangedEventSdvt.args[0];

    const depositCounts = unbufferedAmountNor / ether("32") + unbufferedAmountSdvt / ether("32");

    expect(bufferedEtherAfterDeposit).to.be.equal(
      bufferedEtherBeforeDeposit - unbufferedAmountNor - unbufferedAmountSdvt,
      "Buffered ether after deposit",
    );
    expect(newValidatorsCountSdvt).to.be.equal(
      depositedValidatorsBeforeDeposit + depositCounts,
      "New validators count after deposit",
    );

    log.debug("After deposit", {
      "Buffered ether": ethers.formatEther(bufferedEtherAfterDeposit),
      "Unbuffered amount (NOR)": ethers.formatEther(unbufferedAmountNor),
      "Unbuffered amount (SDVT)": ethers.formatEther(unbufferedAmountSdvt),
      "New validators count (SDVT)": newValidatorsCountSdvt,
    });
  });

  it("Should rebase correctly", async () => {
    const { lido, withdrawalQueue, locator, burner, nor, sdvt } = ctx.contracts;

    const treasuryAddress = await locator.treasury();
    const strangerBalancesBeforeRebase = await getBalances(stranger);

    log.debug("Stranger before rebase", {
      address: stranger.address,
      ETH: ethers.formatEther(strangerBalancesBeforeRebase.ETH),
      stETH: ethers.formatEther(strangerBalancesBeforeRebase.stETH),
    });

    /**
     * If no penalized operators: distributions = number of active validators
     *                      else: distributions = number of active validators + 1 transfer to burner
     */
    const getNodeOperatorsExpectedDistributions = async (registry: typeof sdvt | typeof nor) => {
      const penalizedIds: bigint[] = [];
      let count = await registry.getNodeOperatorsCount();

      for (let i = 0n; i < count; i++) {
        const [operator, isNodeOperatorPenalized] = await Promise.all([
          registry.getNodeOperator(i, false),
          registry.isOperatorPenalized(i),
        ]);

        if (isNodeOperatorPenalized) penalizedIds.push(i);

        const noDepositedValidators = !operator.totalDepositedValidators;
        const allExitedValidators = operator.totalDepositedValidators === operator.totalExitedValidators;

        // if no deposited validators or all exited validators: decrease total active validators count
        if (noDepositedValidators || allExitedValidators) {
          count--;
        }
      }

      const extraBurnerTransfers = penalizedIds.length > 0 ? 1n : 0n;

      return {
        distributions: count + extraBurnerTransfers,
        burned: extraBurnerTransfers,
      };
    };

    const norExpectedDistributions = await getNodeOperatorsExpectedDistributions(nor);
    const sdvtExpectedDistributions = await getNodeOperatorsExpectedDistributions(sdvt);

    log.debug("Expected distributions", {
      "NOR": norExpectedDistributions.distributions,
      "NOR (transfer to burner)": Boolean(norExpectedDistributions.burned),
      "SDVT": sdvtExpectedDistributions.distributions,
      "SDVT (transfer to burner)": Boolean(sdvtExpectedDistributions.burned),
    });

    const treasuryBalanceBeforeRebase = await lido.sharesOf(treasuryAddress);

    const reportParams = { clDiff: ether("100") };
    const { reportTx, extraDataTx } = (await oracleReport(ctx, reportParams)) as {
      reportTx: TransactionResponse;
      extraDataTx: TransactionResponse;
    };

    log.debug("Oracle report", {
      "Report transaction": reportTx.hash,
      "Extra data transaction": extraDataTx.hash,
    });

    const strangerBalancesAfterRebase = await getBalances(stranger);
    const treasuryBalanceAfterRebase = await lido.sharesOf(treasuryAddress);

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;
    const extraDataTxReceipt = (await extraDataTx.wait()) as ContractTransactionReceipt;

    const tokenRebasedEvent = getEvents(reportTxReceipt, "TokenRebased")[0];

    expect(tokenRebasedEvent).not.to.be.undefined;

    const transferEvents = getEvents(reportTxReceipt, "Transfer");

    expect(transferEvents.length).to.be.equal(4, "Transfer events count");
    expect(transferEvents[0].args.from).to.be.equal(withdrawalQueue.address, "Transfer from (Burner)");
    expect(transferEvents[0].args.to).to.be.equal(ctx.contracts.burner.address, "Transfer to (Burner)");
    expect(transferEvents[1].args.from).to.be.equal(ZeroAddress, "Transfer from (NOR deposit)");
    expect(transferEvents[1].args.to).to.be.equal(nor.address, "Transfer to (NOR deposit)");
    expect(transferEvents[2].args.from).to.be.equal(ZeroAddress, "Transfer from (sDVT deposit)");
    expect(transferEvents[2].args.to).to.be.equal(sdvt.address, "Transfer to (sDVT deposit)");
    expect(transferEvents[3].args.from).to.be.equal(ZeroAddress, "Transfer from (Treasury)");
    expect(transferEvents[3].args.to).to.be.equal(treasuryAddress, "Transfer to (Treasury)");

    const treasurySharesMinted = await lido.getSharesByPooledEth(transferEvents[3].args.value);

    expect(treasuryBalanceAfterRebase).to.be.approximately(
      treasuryBalanceBeforeRebase + treasurySharesMinted,
      10n,
      "Treasury balance after rebase",
    );

    expect(treasuryBalanceAfterRebase).to.be.gt(treasuryBalanceBeforeRebase, "Treasury balance after rebase increased");
    expect(strangerBalancesAfterRebase.stETH).to.be.gt(
      strangerBalancesBeforeRebase.stETH,
      "Stranger stETH balance after rebase increased",
    );

    const expectedBurnerTransfers = norExpectedDistributions.burned + sdvtExpectedDistributions.burned;
    const transfers = getEvents(extraDataTxReceipt, "Transfer");
    const burnerTransfers = transfers.filter(e => e?.args[1] == burner.address).length;

    expect(burnerTransfers).to.be.equal(expectedBurnerTransfers, "Burner transfers is correct");

    // TODO: fix Transfers count for distributions is correct error
    // const expectedDistributions = norExpectedDistributions.distributions + sdvtExpectedDistributions.distributions;
    // const distributions = getEvents(extraDataTxReceipt, "Transfer").length;
    // expect(distributions).to.be.equal(expectedDistributions, "Transfers count for distributions is correct");

    expect(getEvents(reportTxReceipt, "TokenRebased")[0]).not.to.be.undefined;
    expect(getEvents(reportTxReceipt, "WithdrawalsFinalized")[0]).not.to.be.undefined;
    const burntSharesEvent = getEvents(reportTxReceipt, "StETHBurnt")[0];

    expect(burntSharesEvent).not.to.be.undefined;

    const burntShares: bigint = burntSharesEvent.args[2];
    const [, , preTotalShares, , postTotalShares, , sharesMintedAsFees] = tokenRebasedEvent.args;

    expect(postTotalShares).to.be.equal(preTotalShares + sharesMintedAsFees - burntShares, "Post total shares");
  });

  it("Should allow request withdrawals", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const withdrawalsFromStrangerBeforeRequest = await withdrawalQueue.connect(stranger).getWithdrawalRequests(stranger);

    expect(withdrawalsFromStrangerBeforeRequest.length).to.be.equal(0, "Withdrawals from stranger");

    const balanceBeforeRequest = await getBalances(stranger);

    log.debug("Stranger withdrawals before request", {
      address: stranger.address,
      withdrawals: withdrawalsFromStrangerBeforeRequest.length,
      ETH: ethers.formatEther(balanceBeforeRequest.ETH),
      stETH: ethers.formatEther(balanceBeforeRequest.stETH),
    });

    amountWithRewards = balanceBeforeRequest.stETH;

    const approveTx = await lido.connect(stranger).approve(withdrawalQueue.address, amountWithRewards);
    const approveTxReceipt = await trace<ContractTransactionReceipt>("lido.approve", approveTx);

    const approveEvent = getEvents(approveTxReceipt, "Approval")[0];

    expect(approveEvent).not.to.be.undefined;
    expect(approveEvent.args.owner).to.be.equal(stranger, "Approval event owner");
    expect(approveEvent.args.spender).to.be.equal(withdrawalQueue.address, "Approval event spender");
    expect(approveEvent.args.value).to.be.equal(amountWithRewards, "Approval event value");

    const lastRequestIdBefore = await withdrawalQueue.getLastRequestId();

    const withdrawalTx = await withdrawalQueue.connect(stranger).requestWithdrawals([amountWithRewards], stranger);
    const withdrawalTxReceipt = await trace<ContractTransactionReceipt>("withdrawalQueue.requestWithdrawals", withdrawalTx);

    const withdrawalEvent = getEvents(withdrawalTxReceipt, "WithdrawalRequested")[0];

    expect(withdrawalEvent).not.to.be.undefined;
    expect(withdrawalEvent.args.requestor).to.be.equal(stranger, "WithdrawalRequested event requestor");
    expect(withdrawalEvent.args.owner).to.be.equal(stranger, "WithdrawalRequested event owner");
    expect(withdrawalEvent.args.amountOfStETH).to.be.equal(amountWithRewards, "WithdrawalRequested event amountOfStETH");

    requestIds = [withdrawalEvent.args.toArray()[0]];

    const withdrawalTransferEvents = getEvents(withdrawalTxReceipt, "Transfer");

    expect(withdrawalTransferEvents.length).to.be.least(2, "Transfer events count");
    expect(withdrawalTransferEvents[0].args.from).to.be.equal(stranger, "Transfer stETH from (Stranger)");
    expect(withdrawalTransferEvents[0].args.to).to.be.equal(withdrawalQueue.address, "Transfer stETH to (WithdrawalQueue)");
    expect(withdrawalTransferEvents[0].args.value).to.be.equal(amountWithRewards, "Transfer stETH value");
    expect(withdrawalTransferEvents[1].args.tokenId).to.be.equal(requestIds[0], "Transfer unstETH tokenId");
    expect(withdrawalTransferEvents[1].args.from).to.be.equal(ZeroAddress, "Transfer unstETH from (ZeroAddress)");
    expect(withdrawalTransferEvents[1].args.to).to.be.equal(stranger, "Transfer unstETH to (Stranger)");

    const balanceAfterRequest = await getBalances(stranger);

    const withdrawalsFromStrangerAfterRequest = await withdrawalQueue.connect(stranger).getWithdrawalRequests(stranger);
    const [status] = await withdrawalQueue.getWithdrawalStatus(requestIds);

    log.debug("Stranger withdrawals after request", {
      address: stranger.address,
      withdrawals: withdrawalsFromStrangerAfterRequest.length,
      ETH: ethers.formatEther(balanceAfterRequest.ETH),
      stETH: ethers.formatEther(balanceAfterRequest.stETH),
    });

    expect(withdrawalsFromStrangerAfterRequest.length).to.be.equal(1, "Withdrawals from stranger after request");
    expect(status.isFinalized).to.be.false;

    expect(balanceAfterRequest.stETH).to.be.approximately(0, 10n, "stETH balance after request");

    const lastRequestIdAfter = await withdrawalQueue.getLastRequestId();
    expect(lastRequestIdAfter).to.be.equal(lastRequestIdBefore + 1n, "Last request ID after request");
  });

  it("Should finalize withdrawals", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    log.debug("Finalizing withdrawals", {
      "Uncounted stETH shares": ethers.formatEther(uncountedStETHShares),
      "Amount with rewards": ethers.formatEther(amountWithRewards),
    });

    const uncountedStETHBalanceBeforeFinalization = await lido.getPooledEthByShares(uncountedStETHShares);
    const withdrawalQueueBalanceBeforeFinalization = await lido.balanceOf(withdrawalQueue.address);
    const expectedWithdrawalAmount = amountWithRewards + uncountedStETHBalanceBeforeFinalization;

    log.debug("Withdrawal queue balance before finalization", {
      "Uncounted stETH balance": ethers.formatEther(uncountedStETHBalanceBeforeFinalization),
      "Withdrawal queue balance": ethers.formatEther(withdrawalQueueBalanceBeforeFinalization),
      "Expected withdrawal amount": ethers.formatEther(expectedWithdrawalAmount),
    });

    expect(withdrawalQueueBalanceBeforeFinalization).to.be.approximately(expectedWithdrawalAmount, 10n, "Withdrawal queue balance before finalization");

    lockedEtherAmountBeforeFinalization = await withdrawalQueue.getLockedEtherAmount();

    const reportParams = { clDiff: ether("100") };
    const { reportTx } = (await oracleReport(ctx, reportParams)) as { reportTx: TransactionResponse };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

    const lockedEtherAmountAfterFinalization = await withdrawalQueue.getLockedEtherAmount();
    const expectedLockedEtherAmountAfterFinalization = lockedEtherAmountAfterFinalization - amountWithRewards;

    expect(lockedEtherAmountBeforeFinalization).to.be.equal(expectedLockedEtherAmountAfterFinalization, "Locked ether amount after finalization");

    const withdrawalFinalizedEvent = getEvents(reportTxReceipt, "WithdrawalsFinalized")[0];

    expect(withdrawalFinalizedEvent).not.to.be.undefined;
    expect(withdrawalFinalizedEvent.args.amountOfETHLocked).to.be.equal(amountWithRewards, "WithdrawalFinalized event amountOfETHLocked");
    expect(withdrawalFinalizedEvent.args.from).to.be.equal(requestIds[0], "WithdrawalFinalized event from");
    expect(withdrawalFinalizedEvent.args.to).to.be.equal(requestIds[0], "WithdrawalFinalized event to");

    const withdrawalQueueBalanceAfterFinalization = await lido.balanceOf(withdrawalQueue.address);
    const uncountedStETHBalanceAfterFinalization = await lido.getPooledEthByShares(uncountedStETHShares);

    expect(withdrawalQueueBalanceAfterFinalization).to.be.equal(uncountedStETHBalanceAfterFinalization, "Withdrawal queue balance after finalization");
  });

  it("Should claim withdrawals", async () => {
    const { withdrawalQueue } = ctx.contracts;

    const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex();

    // in fact, it's a proxy and not a real array, so we need to convert it to array
    const hintsProxy = await withdrawalQueue.findCheckpointHints(requestIds, 1n, lastCheckpointIndex) as Result;
    const hints = hintsProxy.toArray();

    const [claimableEtherBeforeClaim] = await withdrawalQueue.getClaimableEther(requestIds, hints);
    const [status] = await withdrawalQueue.getWithdrawalStatus(requestIds);

    const balanceBeforeClaim = await getBalances(stranger);

    expect(status.isFinalized).to.be.true;
    expect(claimableEtherBeforeClaim).to.be.equal(amountWithRewards, "Claimable ether before claim");

    const claimTx = await withdrawalQueue.connect(stranger).claimWithdrawals(requestIds, hints);
    const claimTxReceipt = await trace<ContractTransactionReceipt>("withdrawalQueue.claimWithdrawals", claimTx);

    const spentGas = claimTxReceipt.gasUsed * claimTxReceipt.gasPrice;

    const claimEvent = getEvents(claimTxReceipt, "WithdrawalClaimed")[0];

    expect(claimEvent).not.to.be.undefined;
    expect(claimEvent.args.requestId).to.be.equal(requestIds[0], "WithdrawalClaimed event requestId");
    expect(claimEvent.args.owner).to.be.equal(stranger, "WithdrawalClaimed event owner");
    expect(claimEvent.args.receiver).to.be.equal(stranger, "WithdrawalClaimed event receiver");
    expect(claimEvent.args.amountOfETH).to.be.equal(amountWithRewards, "WithdrawalClaimed event amountOfETH");

    const transferEvent = getEvents(claimTxReceipt, "Transfer")[0];

    expect(transferEvent).not.to.be.undefined;
    expect(transferEvent.args.from).to.be.equal(stranger.address, "Transfer from (Stranger)");
    expect(transferEvent.args.to).to.be.equal(ZeroAddress, "Transfer to (ZeroAddress)");
    expect(transferEvent.args.tokenId).to.be.equal(requestIds[0], "Transfer value");

    const balanceAfterClaim = await getBalances(stranger);

    expect(balanceAfterClaim.ETH).to.be.equal(balanceBeforeClaim.ETH + amountWithRewards - spentGas, "ETH balance after claim");

    // const lockedEtherAmountAfterClaim = await withdrawalQueue.getLockedEtherAmount();

    // TODO: fix locked ether amount after claim
    // expect(lockedEtherAmountAfterClaim).to.be.equal(lockedEtherAmountBeforeFinalization - amountWithRewards, "Locked ether amount after claim");

    const [statusAfterClaim] = await withdrawalQueue.connect(stranger).getWithdrawalStatus(requestIds);

    expect(statusAfterClaim.isFinalized).to.be.true;
    expect(statusAfterClaim.isClaimed).to.be.true;

    const [claimableEtherAfterClaim] = await withdrawalQueue.getClaimableEther(requestIds, hints);

    expect(claimableEtherAfterClaim).to.be.equal(0, "Claimable ether after claim");
  });
});
