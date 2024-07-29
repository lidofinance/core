import { expect } from "chai";
import { ContractTransactionReceipt, LogDescription } from "ethers";
import { ethers } from "hardhat";

import { ether, findEventsWithInterfaces } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { report } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const SHARE_RATE_PRECISION = BigInt(10 ** 27);

describe("Protocol", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  beforeEach(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  const getEvents = (receipt: ContractTransactionReceipt, eventName: string) => {
    return findEventsWithInterfaces(receipt, eventName, ctx.interfaces);
  };

  const shareRateFromEvent = (tokenRebasedEvent: LogDescription) => {
    const sharesRateBefore =
      (tokenRebasedEvent.args.preTotalEther * SHARE_RATE_PRECISION) / tokenRebasedEvent.args.preTotalShares;
    const sharesRateAfter =
      (tokenRebasedEvent.args.postTotalEther * SHARE_RATE_PRECISION) / tokenRebasedEvent.args.postTotalShares;
    return { sharesRateBefore, sharesRateAfter };
  };

  // testAccountingNoCLRebase
  it("Should account correctly with no CL rebase", async () => {
    const { lido, accountingOracle } = ctx.contracts;

    const blockBeforeReport = await ethers.provider.getBlockNumber();
    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();
    const ethBalanceBefore = await ethers.provider.getBalance(lido.address, blockBeforeReport);

    // Report
    const { reportTx } = await report(ctx, { clDiff: 0n, excludeVaultsBalances: true });
    const blockAfterReport = await ethers.provider.getBlockNumber();
    const reportTxReceipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const withdrawalsFinalized = getEvents(reportTxReceipt, "WithdrawalsFinalized");
    const sharesBurnt = getEvents(reportTxReceipt, "SharesBurnt");

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot({ blockTag: blockAfterReport });
    expect(lastProcessingRefSlotBefore).to.be.lessThan(lastProcessingRefSlotAfter);

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected({ blockTag: blockAfterReport });
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther({ blockTag: blockAfterReport });
    expect(totalPooledEtherBefore).to.equal(totalPooledEtherAfter + withdrawalsFinalized[0].args.amountOfETHLocked);

    const totalSharesAfter = await lido.getTotalShares({ blockTag: blockAfterReport });
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurnt[0].args.sharesAmount);

    const tokenRebasedEvent = getEvents(reportTxReceipt, "TokenRebased");
    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateBefore).to.be.lessThanOrEqual(sharesRateAfter);

    const postTotalSharesEvent = getEvents(reportTxReceipt, "PostTotalShares");
    expect(postTotalSharesEvent[0].args.preTotalPooledEther).to.equal(
      postTotalSharesEvent[0].args.postTotalPooledEther + withdrawalsFinalized[0].args.amountOfETHLocked,
    );

    const ethBalanceAfter = await ethers.provider.getBalance(lido.address, blockAfterReport);
    expect(ethBalanceBefore).to.equal(ethBalanceAfter + withdrawalsFinalized[0].args.amountOfETHLocked);
  });

  it("Should account correctly with negative CL rebase", async () => {
    const { lido, accountingOracle } = ctx.contracts;

    const REBASE_AMOUNT = ether("-1000");

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const { reportTx } = await report(ctx, { clDiff: REBASE_AMOUNT, excludeVaultsBalances: true });
    const blockAfterReport = await ethers.provider.getBlockNumber();
    const reportTxReceipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const withdrawalsFinalized = getEvents(reportTxReceipt, "WithdrawalsFinalized");
    const sharesBurnt = getEvents(reportTxReceipt, "SharesBurnt");

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot({ blockTag: blockAfterReport });
    expect(lastProcessingRefSlotBefore).to.be.lessThan(lastProcessingRefSlotAfter);

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected({ blockTag: blockAfterReport });
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther({ blockTag: blockAfterReport });
    expect(totalPooledEtherBefore + REBASE_AMOUNT).to.equal(
      totalPooledEtherAfter + withdrawalsFinalized[0].args.amountOfETHLocked,
    );

    const totalSharesAfter = await lido.getTotalShares({ blockTag: blockAfterReport });
    expect(totalSharesBefore).to.equal(totalSharesAfter + sharesBurnt[0].args.sharesAmount);

    const tokenRebasedEvent = getEvents(reportTxReceipt, "TokenRebased");
    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateAfter).to.be.lessThan(sharesRateBefore);

    const ethDistributedEvent = getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance + REBASE_AMOUNT).to.equal(
      ethDistributedEvent[0].args.postCLBalance,
    );

    const postTotalSharesEvent = getEvents(reportTxReceipt, "PostTotalShares");
    expect(postTotalSharesEvent[0].args.preTotalPooledEther + REBASE_AMOUNT).to.equal(
      postTotalSharesEvent[0].args.postTotalPooledEther + withdrawalsFinalized[0].args.amountOfETHLocked,
    );
  });
});
