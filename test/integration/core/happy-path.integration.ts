import { expect } from "chai";
import { ContractTransactionReceipt, Result, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime, batch, ether, impersonate, log, updateBalance } from "lib";
import {
  finalizeWQViaElVault,
  getProtocolContext,
  norSdvtEnsureOperators,
  OracleReportParams,
  ProtocolContext,
  report,
} from "lib/protocol";

import { bailOnFailure, MAX_DEPOSIT, Snapshot, ZERO_HASH } from "test/suite";

import { LogDescriptionExtended } from "../../../lib/protocol/types";

const AMOUNT = ether("100");

describe("Scenario: Protocol Happy Path", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let uncountedStETHShares: bigint;
  let amountWithRewards: bigint;
  let depositCount: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    [stEthHolder, stranger] = await ethers.getSigners();
    await updateBalance(stranger.address, ether("100000000"));
    await updateBalance(stEthHolder.address, ether("100000000"));

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

  beforeEach(bailOnFailure);

  it("Should finalize withdrawal queue", async () => {
    const { lido, withdrawalQueue } = ctx.contracts;

    const stEthHolderAmount = ether("1000");

    // Deposit some eth
    await lido.connect(stEthHolder).submit(ZeroAddress, { value: stEthHolderAmount });

    const stEthHolderBalance = await lido.balanceOf(stEthHolder.address);
    expect(stEthHolderBalance).to.approximately(stEthHolderAmount, 10n, "stETH balance increased");

    await finalizeWQViaElVault(ctx);

    const lastFinalizedRequestId = await withdrawalQueue.getLastFinalizedRequestId();
    const lastRequestId = await withdrawalQueue.getLastRequestId();

    // Will be used in finalization part
    uncountedStETHShares = await lido.sharesOf(withdrawalQueue.address);

    // Added to facilitate the burner transfers
    await lido.connect(stEthHolder).approve(withdrawalQueue.address, 1000n);
    await withdrawalQueue.connect(stEthHolder).requestWithdrawals([1000n], stEthHolder);

    expect(lastFinalizedRequestId).to.equal(lastRequestId);
  });

  it("Should have at least 3 node operators in every module", async () => {
    await norSdvtEnsureOperators(ctx, ctx.contracts.nor, 3n, 5n);
    expect(await ctx.contracts.nor.getNodeOperatorsCount()).to.be.at.least(3n);

    await norSdvtEnsureOperators(ctx, ctx.contracts.sdvt, 3n, 5n);
    expect(await ctx.contracts.sdvt.getNodeOperatorsCount()).to.be.at.least(3n);
  });

  it("Should allow ETH holders to submit 100 ETH stake", async () => {
    const { lido } = ctx.contracts;

    const strangerBalancesBeforeSubmit = await getBalances(stranger);

    log.debug("Stranger before submit", {
      address: stranger.address,
      ETH: ethers.formatEther(strangerBalancesBeforeSubmit.ETH),
      stETH: ethers.formatEther(strangerBalancesBeforeSubmit.stETH),
    });

    expect(strangerBalancesBeforeSubmit.stETH).to.equal(0n, "stETH balance before submit");
    expect(strangerBalancesBeforeSubmit.ETH).to.equal(ether("100000000"), "ETH balance before submit");

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
    const receipt = (await tx.wait()) as ContractTransactionReceipt;

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
        stakingLimitBeforeSubmit - AMOUNT + BigInt(growthPerBlock),
        "Staking limit after submit",
      );
    }
  });

  it("Should deposit to staking modules", async () => {
    const { lido, withdrawalQueue, stakingRouter, depositSecurityModule } = ctx.contracts;

    await lido.connect(stEthHolder).submit(ZeroAddress, { value: ether("3200") });

    const withdrawalsUnfinalizedStETH = await withdrawalQueue.unfinalizedStETH();
    const depositableEther = await lido.getDepositableEther();

    const bufferedEtherBeforeDeposit = await lido.getBufferedEther();

    const expectedDepositableEther = bufferedEtherBeforeDeposit - withdrawalsUnfinalizedStETH;

    expect(depositableEther).to.equal(expectedDepositableEther, "Depositable ether");

    log.debug("Depositable ether", {
      "Buffered ether": ethers.formatEther(bufferedEtherBeforeDeposit),
      "Withdrawals unfinalized stETH": ethers.formatEther(withdrawalsUnfinalizedStETH),
      "Depositable ether": ethers.formatEther(depositableEther),
    });

    const dsmSigner = await impersonate(depositSecurityModule.address, ether("100"));
    const stakingModules = (await stakingRouter.getStakingModules()).filter((m) => m.id === 1n);
    depositCount = 0n;
    let expectedBufferedEtherAfterDeposit = bufferedEtherBeforeDeposit;
    for (const module of stakingModules) {
      const depositTx = await lido.connect(dsmSigner).deposit(MAX_DEPOSIT, module.id, ZERO_HASH);
      const depositReceipt = (await depositTx.wait()) as ContractTransactionReceipt;
      const unbufferedEvent = ctx.getEvents(depositReceipt, "Unbuffered")[0];
      const unbufferedAmount = unbufferedEvent?.args[0] || 0n;
      const deposits = unbufferedAmount / ether("32");

      log.debug("Staking module", {
        "Module": module.name,
        "Deposits": deposits,
        "Unbuffered amount": ethers.formatEther(unbufferedAmount),
      });

      depositCount += deposits;
      expectedBufferedEtherAfterDeposit -= unbufferedAmount;
    }

    expect(depositCount).to.be.gt(0n, "No deposits applied");

    const bufferedEtherAfterDeposit = await lido.getBufferedEther();
    expect(bufferedEtherAfterDeposit).to.equal(expectedBufferedEtherAfterDeposit, "Buffered ether after deposit");

    log.debug("After deposit", {
      "Deposits": depositCount,
      "Buffered ether": ethers.formatEther(bufferedEtherAfterDeposit),
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
    const sdvtStatus = await getNodeOperatorsStatus(sdvt);

    const expectedBurnerTransfers =
      (norStatus.hasPenalizedOperators ? 1n : 0n) + (sdvtStatus.hasPenalizedOperators ? 1n : 0n);

    log.debug("Expected distributions", {
      "NOR active operators": norStatus.activeOperators,
      "NOR (transfer to burner)": norStatus.hasPenalizedOperators,
      "SDVT active operators": sdvtStatus.activeOperators,
      "SDVT (transfer to burner)": sdvtStatus.hasPenalizedOperators,
    });

    const treasuryBalanceBeforeRebase = await lido.sharesOf(treasuryAddress);

    // 0.001 – to simulate rewards
    const reportData: Partial<OracleReportParams> = {
      clDiff: ether("32") * depositCount + ether("0.001"),
      clAppearedValidators: depositCount,
    };

    await advanceChainTime(12n * 60n * 60n);
    const { reportTx, extraDataTx, data } = await report(ctx, reportData);
    const wereWithdrawalsFinalized = data.withdrawalFinalizationBatches.length > 0;

    log.debug("Oracle report", {
      "Report transaction": reportTx!.hash,
      "Extra data transaction": extraDataTx!.hash,
    });

    const strangerBalancesAfterRebase = await getBalances(stranger);
    const treasuryBalanceAfterRebase = await lido.sharesOf(treasuryAddress);

    const reportTxReceipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const tokenRebasedEvent = ctx.getEvents(reportTxReceipt, "TokenRebased")[0];

    expect(tokenRebasedEvent).not.to.be.undefined;

    const transferEvents = ctx.getEvents(reportTxReceipt, "Transfer");
    const transferSharesEvents = ctx.getEvents(reportTxReceipt, "TransferShares");

    let toBurnerTransfer,
      toNorTransfer,
      toSdvtTransfer,
      toTreasuryTransfer,
      toTreasuryTransferShares: LogDescriptionExtended | undefined;
    let numExpectedTransferEvents = 3;
    if (wereWithdrawalsFinalized) {
      numExpectedTransferEvents += 1;
      [toBurnerTransfer, toNorTransfer, toSdvtTransfer] = transferEvents;
    } else {
      [toNorTransfer, toSdvtTransfer] = transferEvents;
    }
    if (ctx.flags.withCSM) {
      toTreasuryTransfer = transferEvents[numExpectedTransferEvents];
      toTreasuryTransferShares = transferSharesEvents[numExpectedTransferEvents];
      numExpectedTransferEvents += 2;
    } else {
      toTreasuryTransfer = transferEvents[numExpectedTransferEvents - 1];
      toTreasuryTransferShares = transferSharesEvents[numExpectedTransferEvents - 1];
    }

    expect(transferEvents.length).to.equal(numExpectedTransferEvents, "Transfer events count");

    if (toBurnerTransfer) {
      expect(toBurnerTransfer?.args.toObject()).to.include(
        {
          from: withdrawalQueue.address,
          to: burner.address,
        },
        "Transfer to burner",
      );
    }

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
    expect(toTreasuryTransferShares?.args.toObject()).to.include(
      {
        from: ZeroAddress,
        to: treasuryAddress,
      },
      "Transfer shares to Treasury",
    );

    expect(treasuryBalanceAfterRebase).to.be.approximately(
      treasuryBalanceBeforeRebase + toTreasuryTransferShares.args.sharesValue,
      10n,
      "Treasury balance after rebase",
    );

    expect(treasuryBalanceAfterRebase).to.be.gt(treasuryBalanceBeforeRebase, "Treasury balance after rebase increased");
    expect(strangerBalancesAfterRebase.stETH).to.be.gt(
      strangerBalancesBeforeRebase.stETH,
      "Stranger stETH balance after rebase increased",
    );

    const distributeTx = await nor.connect(stranger).distributeReward();
    const distributeTxReceipt = (await distributeTx.wait()) as ContractTransactionReceipt;
    const transfers = ctx.getEvents(distributeTxReceipt, "Transfer");

    const burnerTransfers = transfers.filter((e) => e?.args[1] == burner.address).length;

    expect(burnerTransfers).to.equal(expectedBurnerTransfers, "Burner transfers is correct");

    expect(transfers.length).to.equal(
      norStatus.activeOperators + expectedBurnerTransfers,
      "All active operators received transfers",
    );

    log.debug("Transfers", {
      "Transfers to NOR operators": norStatus.activeOperators,
      "Burner transfers": burnerTransfers,
    });

    expect(ctx.getEvents(reportTxReceipt, "TokenRebased")[0]).not.to.be.undefined;
    if (wereWithdrawalsFinalized) {
      expect(ctx.getEvents(reportTxReceipt, "WithdrawalsFinalized")[0]).not.to.be.undefined;
    }

    let burntShares = 0n;
    if (wereWithdrawalsFinalized) {
      const burntSharesEvent = ctx.getEvents(reportTxReceipt, "StETHBurnt")[0];
      expect(burntSharesEvent).not.to.be.undefined;
      burntShares = burntSharesEvent.args[2];
    }

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
    const approveTxReceipt = (await approveTx.wait()) as ContractTransactionReceipt;

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
    const withdrawalTxReceipt = (await withdrawalTx.wait()) as ContractTransactionReceipt;
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
    const claimTxReceipt = (await claimTx.wait()) as ContractTransactionReceipt;
    const claimEvent = ctx.getEvents(claimTxReceipt, "WithdrawalClaimed")[0];

    const spentGas = claimTxReceipt.gasUsed * claimTxReceipt.gasPrice;

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
