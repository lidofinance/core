import { expect } from "chai";
import { ContractTransactionReceipt, LogDescription } from "ethers";
import { ethers } from "hardhat";

import { ether, findEventsWithInterfaces, ONE_GWEI } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { report } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const SHARE_RATE_PRECISION = BigInt(10 ** 27);
const ONE_DAY = 86400n;
const MAX_BASIS_POINTS = 10000n;

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

  const roundToGwei = (value: bigint) => {
    return (value / ONE_GWEI) * ONE_GWEI;
  };

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

  it("Should account correctly with positive CL rebase close to the limits", async () => {
    const { lido, accountingOracle, oracleReportSanityChecker, stakingRouter } = ctx.contracts;

    const annualIncreaseLimit = (await oracleReportSanityChecker.getOracleReportLimits())[2];
    const preCLBalance = (await lido.getBeaconStat()).slice(-1)[0];

    let rebaseAmount = (preCLBalance * annualIncreaseLimit * (ONE_DAY + 1n)) / (365n * ONE_DAY) / MAX_BASIS_POINTS;
    rebaseAmount = roundToGwei(rebaseAmount);

    const lastProcessingRefSlotBefore = await accountingOracle.getLastProcessingRefSlot();
    const totalELRewardsCollectedBefore = await lido.getTotalELRewardsCollected();
    const totalPooledEtherBefore = await lido.getTotalPooledEther();
    const totalSharesBefore = await lido.getTotalShares();

    // Report
    const { reportTx } = await report(ctx, { clDiff: rebaseAmount, excludeVaultsBalances: true });
    const reportTxReceipt = (await reportTx!.wait()) as ContractTransactionReceipt;

    const withdrawalsFinalized = getEvents(reportTxReceipt, "WithdrawalsFinalized");
    const sharesBurnt = getEvents(reportTxReceipt, "SharesBurnt");

    const lastProcessingRefSlotAfter = await accountingOracle.getLastProcessingRefSlot();
    expect(lastProcessingRefSlotBefore).to.be.lessThan(lastProcessingRefSlotAfter);

    const totalELRewardsCollectedAfter = await lido.getTotalELRewardsCollected();
    expect(totalELRewardsCollectedBefore).to.equal(totalELRewardsCollectedAfter);

    const totalPooledEtherAfter = await lido.getTotalPooledEther();
    expect(totalPooledEtherBefore + rebaseAmount).to.equal(
      totalPooledEtherAfter + withdrawalsFinalized[0].args.amountOfETHLocked,
    );

    const sharesAsFeesList = getEvents(reportTxReceipt, "TransferShares").map((e) => e.args.sharesValue);
    let mintedSharesSum = 0n;

    if (withdrawalsFinalized[0].args.amountOfETHLocked == 0) {
      expect(sharesAsFeesList.length).to.equal(3);

      const simpleDVTStats = await stakingRouter.getStakingModule(2);
      const simpleDVTTreasuryFee =
        (((sharesAsFeesList[1] * 10000n) / simpleDVTStats.stakingModuleFee) * simpleDVTStats.treasuryFee) / 10000n;
      expect(sharesAsFeesList[0] + simpleDVTTreasuryFee).to.approximately(sharesAsFeesList[2], 100);

      mintedSharesSum = sharesAsFeesList[0] + sharesAsFeesList[1] + sharesAsFeesList[2];
    } else {
      const stakingModulesCount = await stakingRouter.getStakingModulesCount();
      expect(sharesAsFeesList.length).to.equal(2n + stakingModulesCount);

      const simpleDVTStats = await stakingRouter.getStakingModule(2);
      const simpleDVTTreasuryFee =
        (((sharesAsFeesList[2] * 10000n) / simpleDVTStats.stakingModuleFee) * simpleDVTStats.treasuryFee) / 10000n;
      expect(sharesAsFeesList[1] + simpleDVTTreasuryFee).to.approximately(
        sharesAsFeesList[Number(stakingModulesCount) + 1],
        100,
      );

      mintedSharesSum = sharesAsFeesList[1] + sharesAsFeesList[2] + sharesAsFeesList[Number(stakingModulesCount) + 1];
    }

    const tokenRebasedEvent = getEvents(reportTxReceipt, "TokenRebased");
    expect(tokenRebasedEvent[0].args.sharesMintedAsFees).to.equal(mintedSharesSum);

    const totalSharesAfter = await lido.getTotalShares();
    expect(totalSharesBefore + mintedSharesSum).to.equal(totalSharesAfter + sharesBurnt[0].args.sharesAmount);

    const { sharesRateBefore, sharesRateAfter } = shareRateFromEvent(tokenRebasedEvent[0]);
    expect(sharesRateAfter).to.be.greaterThan(sharesRateBefore);

    const ethDistributedEvent = getEvents(reportTxReceipt, "ETHDistributed");
    expect(ethDistributedEvent[0].args.preCLBalance + rebaseAmount).to.equal(ethDistributedEvent[0].args.postCLBalance);

    const postTotalSharesEvent = getEvents(reportTxReceipt, "PostTotalShares");
    expect(postTotalSharesEvent[0].args.preTotalPooledEther + rebaseAmount).to.equal(
      postTotalSharesEvent[0].args.postTotalPooledEther + withdrawalsFinalized[0].args.amountOfETHLocked,
    );
  });
});
