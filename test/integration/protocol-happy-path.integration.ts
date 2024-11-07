import { expect } from "chai";
import { ContractTransactionReceipt, Result, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { batch, ether, impersonate, log, trace, updateBalance } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import {
  finalizeWithdrawalQueue,
  norEnsureOperators,
  OracleReportOptions,
  report,
  sdvtEnsureOperators,
} from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const AMOUNT = ether("100");
const MAX_DEPOSIT = 150n;
const CURATED_MODULE_ID = 1n;
const SIMPLE_DVT_MODULE_ID = 2n;

const ZERO_HASH = new Uint8Array(32).fill(0);

describe("Protocol Happy Path", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let uncountedStETHShares: bigint;
  let amountWithRewards: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, ethHolder, stranger] = await ethers.getSigners();

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  const getBalances = async (wallet: HardhatEthersSigner) => {
    const { lido } = ctx.contracts;
    return batch({
      ETH: ethers.provider.getBalance(wallet),
      stETH: lido.balanceOf(wallet),
    });
  };

  it("Should finalize withdrawal queue", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    await finalizeWithdrawalQueue(ctx, stEthHolder, ethHolder);

    const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    const lastRequestId = await withdrawalQueue.getLastRequestId();

    // Will be used in finalization part
    uncountedStETHShares = await lido.sharesOf(withdrawalQueue.address);

    // Added to facilitate the burner transfers
    const approveTx = await lido.connect(stEthHolder).approve(withdrawalQueue.address, 1000n);
    await trace("lido.approve", approveTx);

    const requestWithdrawalsTx = await withdrawalQueue.connect(stEthHolder).requestWithdrawals([1000n], stEthHolder);
    await trace("withdrawalQueue.requestWithdrawals", requestWithdrawalsTx);

    expect(lastFinalizedRequestId).to.equal(lastRequestId);
  });

  it("Should have at least 3 node operators in every module", async () => {
    await norEnsureOperators(ctx, 3n, 5n);
    expect(await ctx.contracts.nor.getNodeOperatorsCount()).to.be.at.least(3n);

    await sdvtEnsureOperators(ctx, 3n, 5n);
    expect(await ctx.contracts.sdvt.getNodeOperatorsCount()).to.be.at.least(3n);
  });

  it("Should allow ETH holders to submit 100 ETH stake", async () => {
    const { lido } = ctx.contracts;

    await updateBalance(stranger.address, ether("1000000"));

    const strangerBalancesBeforeSubmit = await getBalances(stranger);

    log.debug("Stranger before submit", {
      address: stranger.address,
      ETH: ethers.formatEther(strangerBalancesBeforeSubmit.ETH),
      stETH: ethers.formatEther(strangerBalancesBeforeSubmit.stETH),
    });

    expect(strangerBalancesBeforeSubmit.stETH).to.equal(0n, "stETH balance before submit");
    expect(strangerBalancesBeforeSubmit.ETH).to.equal(ether("1000000"), "ETH balance before submit");

    const stakeLimitInfoBefore = await lido.getStakeLimitFullInfo();

    log.debug("Stake limit info before submit", {
      "Max stake limit": ethers.formatEther(stakeLimitInfoBefore.maxStakeLimit),
      "Max stake limit growth blocks": stakeLimitInfoBefore.maxStakeLimitGrowthBlocks,
    });

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

    const submittedEvent = ctx.getEvents(receipt, "Submitted")[0];
    const transferSharesEvent = ctx.getEvents(receipt, "TransferShares")[0];
    const sharesToBeMinted = await lido.getSharesByPooledEth(AMOUNT);
    const mintedShares = await lido.sharesOf(stranger);

    expect(submittedEvent?.args.toObject()).to.deep.equal(
      {
        sender: stranger.address,
        amount: AMOUNT,
        referral: ZeroAddress,
      },
      "Submitted event",
    );

    expect(transferSharesEvent?.args.toObject()).to.deep.equal(
      {
        from: ZeroAddress,
        to: stranger.address,
        sharesValue: sharesToBeMinted,
      },
      "TransferShares event",
    );

    expect(mintedShares).to.equal(sharesToBeMinted, "Minted shares");

    const totalSupplyAfterSubmit = await lido.totalSupply();
    const bufferedEtherAfterSubmit = await lido.getBufferedEther();
    const stakingLimitAfterSubmit = await lido.getCurrentStakeLimit();

    expect(totalSupplyAfterSubmit).to.equal(totalSupplyBeforeSubmit + AMOUNT, "Total supply after submit");
    expect(bufferedEtherAfterSubmit).to.equal(bufferedEtherBeforeSubmit + AMOUNT, "Buffered ether after submit");

    if (stakingLimitBeforeSubmit >= stakeLimitInfoBefore.maxStakeLimit - growthPerBlock) {
      expect(stakingLimitAfterSubmit).to.equal(
        stakingLimitBeforeSubmit - AMOUNT,
        "Staking limit after submit without growth",
      );
    } else {
      expect(stakingLimitAfterSubmit).to.equal(
        stakingLimitBeforeSubmit - AMOUNT + growthPerBlock,
        "Staking limit after submit",
      );
    }
  });

  it("Should deposit 100 ETH to node operators", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const { depositSecurityModule } = ctx.contracts;
    const { depositedValidators: depositedValidatorsBefore } = await lido.getBeaconStat();
    const withdrawalsUninitializedStETH = await withdrawalQueue.unfinalizedStETH();
    const depositableEther = await lido.getDepositableEther();
    const bufferedEtherBeforeDeposit = await lido.getBufferedEther();

    const expectedDepositableEther = bufferedEtherBeforeDeposit - withdrawalsUninitializedStETH;

    expect(depositableEther).to.equal(expectedDepositableEther, "Depositable ether");

    log.debug("Depositable ether", {
      "Buffered ether": ethers.formatEther(bufferedEtherBeforeDeposit),
      "Withdrawals uninitialized stETH": ethers.formatEther(withdrawalsUninitializedStETH),
      "Depositable ether": ethers.formatEther(depositableEther),
    });

    const dsmSigner = await impersonate(depositSecurityModule.address, ether("100"));

    const depositNorTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, CURATED_MODULE_ID, ZERO_HASH);
    const depositNorReceipt = await trace<ContractTransactionReceipt>("lido.deposit (Curated Module)", depositNorTx);

    const unbufferedEventNor = ctx.getEvents(depositNorReceipt, "Unbuffered")[0];
    const unbufferedAmountNor = unbufferedEventNor.args[0];

    const depositCountsNor = unbufferedAmountNor / ether("32");
    let expectedBufferedEtherAfterDeposit = bufferedEtherBeforeDeposit - unbufferedAmountNor;

    const depositSdvtTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, SIMPLE_DVT_MODULE_ID, ZERO_HASH);
    const depositSdvtReceipt = await trace<ContractTransactionReceipt>("lido.deposit (Simple DVT)", depositSdvtTx);

    const unbufferedEventSdvt = ctx.getEvents(depositSdvtReceipt, "Unbuffered")[0];
    const depositedValidatorsChangedEventSdvt = ctx.getEvents(depositSdvtReceipt, "DepositedValidatorsChanged")[0];

    const unbufferedAmountSdvt = unbufferedEventSdvt.args[0];
    const newValidatorsCountSdvt = depositedValidatorsChangedEventSdvt.args[0];

    const depositCountsTotal = depositCountsNor + unbufferedAmountSdvt / ether("32");
    expectedBufferedEtherAfterDeposit -= unbufferedAmountSdvt;

    expect(depositCountsTotal).to.be.gt(0n, "Deposit counts");
    expect(newValidatorsCountSdvt).to.equal(
      depositedValidatorsBefore + depositCountsTotal,
      "New validators count after deposit",
    );

    const bufferedEtherAfterDeposit = await lido.getBufferedEther();

    expect(depositCountsNor).to.be.gt(0n, "Deposit counts");
    expect(bufferedEtherAfterDeposit).to.equal(expectedBufferedEtherAfterDeposit, "Buffered ether after deposit");

    log.debug("After deposit", {
      "Buffered ether": ethers.formatEther(bufferedEtherAfterDeposit),
      "Unbuffered amount (NOR)": ethers.formatEther(unbufferedAmountNor),
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

    const getNodeOperatorsStatus = async (registry: typeof sdvt | typeof nor) => {
      const totalOperators = await registry.getNodeOperatorsCount();
      let hasPenalizedOperators = false;
      let activeOperators = 0n;

      for (let i = 0n; i < totalOperators; i++) {
        const operator = await registry.getNodeOperator(i, false);
        hasPenalizedOperators ||= await registry.isOperatorPenalized(i);

        if (operator.totalDepositedValidators > operator.totalExitedValidators) {
          activeOperators++;
        }
      }

      return { hasPenalizedOperators, activeOperators };
    };

    const norStatus = await getNodeOperatorsStatus(nor);

    let expectedBurnerTransfers = norStatus.hasPenalizedOperators ? 1n : 0n;
    let expectedTransfers = norStatus.activeOperators;

    const sdvtStatus = await getNodeOperatorsStatus(sdvt);

    expectedBurnerTransfers += sdvtStatus.hasPenalizedOperators ? 1n : 0n;
    expectedTransfers += sdvtStatus.activeOperators;

    log.debug("Expected distributions", {
      "NOR active operators": norStatus.activeOperators,
      "NOR (transfer to burner)": norStatus.hasPenalizedOperators,
      "SDVT active operators": sdvtStatus.activeOperators,
      "SDVT (transfer to burner)": sdvtStatus.hasPenalizedOperators,
    });

    const treasuryBalanceBeforeRebase = await lido.sharesOf(treasuryAddress);

    // Stranger deposited 100 ETH, enough to deposit 3 validators, need to reflect this in the report
    // 0.01 ETH is added to the clDiff to simulate some rewards
    const reportData: Partial<OracleReportOptions> = {
      clDiff: ether("96.01"),
      clAppearedValidators: 3n,
    };

    const { reportTx, extraDataTx } = (await report(ctx, reportData)) as {
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

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased")[0];

    expect(tokenRebasedEvent).not.to.be.undefined;

    const transferEvents = ctx.getEvents(reportTxReceipt, "Transfer");

    const toBurnerTransfer = transferEvents[0];
    const toNorTransfer = transferEvents[1];
    const toSdvtTransfer = transferEvents[2];
    const toTreasuryTransfer = transferEvents[3];
    const expectedTransferEvents = 4;

    expect(transferEvents.length).to.equal(expectedTransferEvents, "Transfer events count");

    expect(toBurnerTransfer?.args.toObject()).to.include(
      {
        from: withdrawalQueue.address,
        to: burner.address,
      },
      "Transfer to burner",
    );

    expect(toNorTransfer?.args.toObject()).to.include(
      {
        from: ZeroAddress,
        to: nor.address,
      },
      "Transfer to NOR",
    );

    expect(toSdvtTransfer?.args.toObject()).to.include(
      {
        from: ZeroAddress,
        to: sdvt.address,
      },
      "Transfer to SDVT",
    );

    expect(toTreasuryTransfer?.args.toObject()).to.include(
      {
        from: ZeroAddress,
        to: treasuryAddress,
      },
      "Transfer to Treasury",
    );

    const treasurySharesMinted = await lido.getSharesByPooledEth(toTreasuryTransfer.args.value);

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

    const transfers = ctx.getEvents(extraDataTxReceipt, "Transfer");
    const burnerTransfers = transfers.filter((e) => e?.args[1] == burner.address).length;

    expect(burnerTransfers).to.equal(expectedBurnerTransfers, "Burner transfers is correct");

    expect(transfers.length).to.equal(
      expectedTransfers + expectedBurnerTransfers,
      "All active operators received transfers",
    );

    log.debug("Transfers", {
      "Transfers to operators": expectedTransfers,
      "Burner transfers": burnerTransfers,
    });

    expect(ctx.getEvents(reportTxReceipt, "TokenRebased")[0]).not.to.be.undefined;
    expect(ctx.getEvents(reportTxReceipt, "WithdrawalsFinalized")[0]).not.to.be.undefined;

    const burntSharesEvent = ctx.getEvents(reportTxReceipt, "StETHBurnt")[0];

    expect(burntSharesEvent).not.to.be.undefined;

    const burntShares: bigint = burntSharesEvent.args[2];
    const [, , preTotalShares, , postTotalShares, , sharesMintedAsFees] = tokenRebasedEvent.args;

    expect(postTotalShares).to.equal(preTotalShares + sharesMintedAsFees - burntShares, "Post total shares");
  });

  it("Should allow stETH holder to request withdrawals", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const withdrawalsFromStrangerBeforeRequest = await withdrawalQueue
      .connect(stranger)
      .getWithdrawalRequests(stranger);

    expect(withdrawalsFromStrangerBeforeRequest.length).to.equal(0, "Withdrawals from stranger");

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

    const approveEvent = ctx.getEvents(approveTxReceipt, "Approval")[0];

    expect(approveEvent?.args.toObject()).to.deep.include(
      {
        owner: stranger.address,
        spender: withdrawalQueue.address,
        value: amountWithRewards,
      },
      "Approval event",
    );

    const lastRequestIdBefore = await withdrawalQueue.getLastRequestId();

    const withdrawalTx = await withdrawalQueue.connect(stranger).requestWithdrawals([amountWithRewards], stranger);
    const withdrawalTxReceipt = await trace<ContractTransactionReceipt>(
      "withdrawalQueue.requestWithdrawals",
      withdrawalTx,
    );

    const withdrawalEvent = ctx.getEvents(withdrawalTxReceipt, "WithdrawalRequested")[0];

    expect(withdrawalEvent?.args.toObject()).to.deep.include(
      {
        requestor: stranger.address,
        owner: stranger.address,
        amountOfStETH: amountWithRewards,
      },
      "WithdrawalRequested event",
    );

    const requestId = withdrawalEvent.args.requestId;
    const withdrawalTransferEvents = ctx.getEvents(withdrawalTxReceipt, "Transfer");

    expect(withdrawalTransferEvents.length).to.be.least(2, "Transfer events count");

    const [stEthTransfer, unstEthTransfer] = withdrawalTransferEvents;

    expect(stEthTransfer?.args.toObject()).to.deep.include(
      {
        from: stranger.address,
        to: withdrawalQueue.address,
        value: amountWithRewards,
      },
      "Transfer stETH",
    );

    expect(unstEthTransfer?.args.toObject()).to.deep.include(
      {
        from: ZeroAddress,
        to: stranger.address,
        tokenId: requestId,
      },
      "Transfer unstETH",
    );

    const balanceAfterRequest = await getBalances(stranger);

    const withdrawalsFromStrangerAfterRequest = await withdrawalQueue.connect(stranger).getWithdrawalRequests(stranger);
    const [status] = await withdrawalQueue.getWithdrawalStatus([requestId]);

    log.debug("Stranger withdrawals after request", {
      address: stranger.address,
      withdrawals: withdrawalsFromStrangerAfterRequest.length,
      ETH: ethers.formatEther(balanceAfterRequest.ETH),
      stETH: ethers.formatEther(balanceAfterRequest.stETH),
    });

    expect(withdrawalsFromStrangerAfterRequest.length).to.equal(1, "Withdrawals from stranger after request");
    expect(status.isFinalized).to.be.false;

    expect(balanceAfterRequest.stETH).to.be.approximately(0, 10n, "stETH balance after request");

    const lastRequestIdAfter = await withdrawalQueue.getLastRequestId();
    expect(lastRequestIdAfter).to.equal(lastRequestIdBefore + 1n, "Last request ID after request");
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

    expect(withdrawalQueueBalanceBeforeFinalization).to.be.approximately(
      expectedWithdrawalAmount,
      10n,
      "Withdrawal queue balance before finalization",
    );

    const lockedEtherAmountBeforeFinalization = await withdrawalQueue.getLockedEtherAmount();

    const reportParams = { clDiff: ether("0.0005") }; // simulate some rewards
    const { reportTx } = (await report(ctx, reportParams)) as { reportTx: TransactionResponse };

    const reportTxReceipt = (await reportTx.wait()) as ContractTransactionReceipt;

    const requestId = await withdrawalQueue.getLastRequestId();

    const lockedEtherAmountAfterFinalization = await withdrawalQueue.getLockedEtherAmount();
    const expectedLockedEtherAmountAfterFinalization = lockedEtherAmountAfterFinalization - amountWithRewards;

    log.debug("Locked ether amount", {
      "Before finalization": ethers.formatEther(lockedEtherAmountBeforeFinalization),
      "After finalization": ethers.formatEther(lockedEtherAmountAfterFinalization),
      "Amount with rewards": ethers.formatEther(amountWithRewards),
    });

    expect(lockedEtherAmountBeforeFinalization).to.equal(
      expectedLockedEtherAmountAfterFinalization,
      "Locked ether amount after finalization",
    );

    const withdrawalFinalizedEvent = ctx.getEvents(reportTxReceipt, "WithdrawalsFinalized")[0];

    expect(withdrawalFinalizedEvent?.args.toObject()).to.deep.include(
      {
        amountOfETHLocked: amountWithRewards,
        from: requestId,
        to: requestId,
      },
      "WithdrawalFinalized event",
    );

    const withdrawalQueueBalanceAfterFinalization = await lido.balanceOf(withdrawalQueue.address);
    const uncountedStETHBalanceAfterFinalization = await lido.getPooledEthByShares(uncountedStETHShares);

    expect(withdrawalQueueBalanceAfterFinalization).to.equal(
      uncountedStETHBalanceAfterFinalization,
      "Withdrawal queue balance after finalization",
    );
  });

  it("Should claim withdrawals", async () => {
    const { withdrawalQueue } = ctx.contracts;

    const lockedEtherAmountBeforeWithdrawal = await withdrawalQueue.getLockedEtherAmount();

    const lastCheckpointIndex = await withdrawalQueue.getLastCheckpointIndex();
    const requestId = await withdrawalQueue.getLastRequestId();

    // in fact, it's a proxy and not a real array, so we need to convert it to array
    const hintsProxy = (await withdrawalQueue.findCheckpointHints([requestId], 1n, lastCheckpointIndex)) as Result;
    const hints = hintsProxy.toArray();

    const [claimableEtherBeforeClaim] = await withdrawalQueue.getClaimableEther([requestId], hints);
    const [status] = await withdrawalQueue.getWithdrawalStatus([requestId]);

    const balanceBeforeClaim = await getBalances(stranger);

    expect(status.isFinalized).to.be.true;
    expect(claimableEtherBeforeClaim).to.equal(amountWithRewards, "Claimable ether before claim");

    const claimTx = await withdrawalQueue.connect(stranger).claimWithdrawals([requestId], hints);
    const claimTxReceipt = await trace<ContractTransactionReceipt>("withdrawalQueue.claimWithdrawals", claimTx);

    const spentGas = claimTxReceipt.gasUsed * claimTxReceipt.gasPrice;

    const claimEvent = ctx.getEvents(claimTxReceipt, "WithdrawalClaimed")[0];

    expect(claimEvent?.args.toObject()).to.deep.include(
      {
        requestId,
        owner: stranger.address,
        receiver: stranger.address,
        amountOfETH: amountWithRewards,
      },
      "WithdrawalClaimed event",
    );

    const transferEvent = ctx.getEvents(claimTxReceipt, "Transfer")[0];

    expect(transferEvent?.args.toObject()).to.deep.include(
      {
        from: stranger.address,
        to: ZeroAddress,
        tokenId: requestId,
      },
      "Transfer event",
    );

    const balanceAfterClaim = await getBalances(stranger);

    expect(balanceAfterClaim.ETH).to.equal(
      balanceBeforeClaim.ETH + amountWithRewards - spentGas,
      "ETH balance after claim",
    );

    const lockedEtherAmountAfterClaim = await withdrawalQueue.getLockedEtherAmount();

    log.debug("Locked ether amount", {
      "Before withdrawal": ethers.formatEther(lockedEtherAmountBeforeWithdrawal),
      "After claim": ethers.formatEther(lockedEtherAmountAfterClaim),
      "Amount with rewards": ethers.formatEther(amountWithRewards),
    });

    expect(lockedEtherAmountAfterClaim).to.equal(
      lockedEtherAmountBeforeWithdrawal - amountWithRewards,
      "Locked ether amount after claim",
    );

    const [statusAfterClaim] = await withdrawalQueue.connect(stranger).getWithdrawalStatus([requestId]);

    expect(statusAfterClaim.isFinalized).to.be.true;
    expect(statusAfterClaim.isClaimed).to.be.true;

    const [claimableEtherAfterClaim] = await withdrawalQueue.getClaimableEther([requestId], hints);

    expect(claimableEtherAfterClaim).to.equal(0, "Claimable ether after claim");
  });
});
