import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { ether, findEvents, findEventsWithInterfaces } from "lib";
import { finalizeWQViaElVault, getProtocolContext, ProtocolContext, report } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Withdrawal happy path", () => {
  let ctx: ProtocolContext;
  let holder: HardhatEthersSigner;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();

    [, holder] = await ethers.getSigners();
    await setBalance(holder.address, ether("1000000"));
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should successfully request and claim withdrawals", async () => {
    const REQUESTS_COUNT = 10n;
    const REQUEST_AMOUNT = ether("1");
    const REQUESTS_SUM = REQUEST_AMOUNT * REQUESTS_COUNT;

    const { withdrawalQueue: wq, lido, acl } = ctx.contracts;

    await finalizeWQViaElVault(ctx);

    // Get initial stETH holder balance
    const agentSigner = await ctx.getSigner("agent");
    await acl
      .connect(agentSigner)
      .grantPermission(agentSigner.address, lido.address, await lido.STAKING_CONTROL_ROLE());
    await lido.connect(agentSigner).removeStakingLimit();
    await lido.connect(holder).submit(ethers.ZeroAddress, { value: ether("10000") });
    expect(await lido.balanceOf(holder.address)).to.be.gte(REQUESTS_SUM);

    // Get initial state
    const uncountedStethShares = await lido.sharesOf(wq.target);
    const noRequests = await wq.getWithdrawalRequests(holder.address);
    expect(noRequests.length).to.equal(0);

    const lastRequestId = await wq.getLastRequestId();
    const lastFinalizedRequestId = await wq.getLastFinalizedRequestId();
    const lastCheckpointIndexBefore = await wq.getLastCheckpointIndex();
    const unfinalizedSteth = await wq.unfinalizedStETH();

    const preReportRequestShares = await lido.getSharesByPooledEth(REQUEST_AMOUNT);

    // Make withdrawal requests
    const stethBalanceBefore = await lido.balanceOf(holder.address);
    await lido.connect(holder).approve(wq.target, REQUESTS_SUM);
    const requests = Array(parseInt(REQUESTS_COUNT.toString())).fill(REQUEST_AMOUNT);
    const requestTx = await wq.connect(holder).requestWithdrawals(requests, holder.address);
    const stethBalanceAfter = await lido.balanceOf(holder.address);

    // Verify request state
    expect(stethBalanceBefore - stethBalanceAfter).to.be.closeTo(REQUESTS_SUM, 3n * REQUESTS_COUNT); // each transfer can have rounding up to 3 wei

    const sharesToBurn = (await lido.sharesOf(wq.target)) - uncountedStethShares;

    const requestReceipt = await requestTx.wait();
    const withdrawalRequestedEvents = findEventsWithInterfaces(requestReceipt!, "WithdrawalRequested", [wq.interface]);
    expect(withdrawalRequestedEvents?.length).to.equal(REQUESTS_COUNT);
    withdrawalRequestedEvents?.forEach((event, i) => {
      expect(event?.args.requestId).to.equal(BigInt(i) + lastRequestId + 1n);
      expect(event?.args.amountOfStETH).to.be.closeTo(REQUEST_AMOUNT, 1n);
      expect(event?.args.amountOfShares).to.be.closeTo(preReportRequestShares, 1n);
      expect(event?.args.requestor).to.equal(holder.address);
      expect(event?.args.owner).to.equal(holder.address);
    });

    // Verify NFT transfers (token transfers logs have the same signature as NFT transfers so
    // filtering them also by number of indexed params)
    const transferEvents = findEventsWithInterfaces(requestReceipt!, "Transfer", [wq.interface], 3);
    expect(transferEvents?.length).to.equal(REQUESTS_COUNT);
    transferEvents?.forEach((event, i) => {
      expect(event?.args.tokenId).to.equal(BigInt(i) + lastRequestId + 1n);
      expect(event?.args.from).to.equal(ethers.ZeroAddress);
      expect(event?.args.to).to.equal(holder.address);
    });

    // Check request statuses
    const requestIds = await wq.getWithdrawalRequests(holder.address);
    const statuses = await wq.getWithdrawalStatus([...requestIds]);
    const claimableEther = await wq.getClaimableEther([...requestIds], Array(requestIds.length).fill(0));
    expect(requestIds.length).to.equal(REQUESTS_COUNT);
    expect(statuses.length).to.equal(REQUESTS_COUNT);
    requestIds.forEach((requestId, i) => {
      expect(requestId).to.equal(BigInt(i) + lastRequestId + 1n);
      const [amountOfStETH, amountOfShares, owner, , isFinalized, isClaimed] = statuses[i];
      expect(amountOfStETH).to.be.closeTo(REQUEST_AMOUNT, 1n);
      expect(amountOfShares).to.be.closeTo(preReportRequestShares, 1n);
      expect(owner).to.equal(holder.address);
      expect(isFinalized).to.be.false;
      expect(isClaimed).to.be.false;
      expect(claimableEther[i]).to.equal(0);
    });

    // First oracle report
    let reportTx = (await report(ctx, { clDiff: ether("0.00000000000001") })).reportTx;
    const reportReceipt = await reportTx!.wait();

    // second report requests will get finalized for sure
    if (findEvents(reportReceipt!, "WithdrawalsFinalized").length !== 1) {
      reportTx = (await report(ctx, { clDiff: ether("0.00000000000001") })).reportTx;
    }

    const [parsedFinalizedEvent] = findEventsWithInterfaces(reportReceipt!, "WithdrawalsFinalized", [wq.interface]);
    expect(parsedFinalizedEvent?.args.from).to.equal(lastFinalizedRequestId + 1n);
    expect(parsedFinalizedEvent?.args.to).to.equal(REQUESTS_COUNT + lastRequestId);
    expect(parsedFinalizedEvent?.args.amountOfETHLocked).to.be.closeTo(
      REQUESTS_SUM + unfinalizedSteth,
      2n * REQUESTS_COUNT,
    );
    expect(parsedFinalizedEvent?.args.sharesToBurn).to.be.closeTo(sharesToBurn, 1n);

    // Verify post-finalization state
    expect(await wq.getLastFinalizedRequestId()).to.equal(requestIds[requestIds.length - 1]);
    const lastCheckpointIndex = await wq.getLastCheckpointIndex();
    expect(lastCheckpointIndex).to.equal(lastCheckpointIndexBefore + 1n);

    // Verify post-report state
    const postReportStatuses = await wq.getWithdrawalStatus([...requestIds]);
    const postReportClaimableEther = await wq.getClaimableEther(
      [...requestIds],
      Array(requestIds.length).fill(lastCheckpointIndex),
    );

    requestIds.forEach((requestId, i) => {
      expect(requestId).to.equal(BigInt(i) + lastRequestId + 1n);
      const [amountOfStETH, amountOfShares, owner, , isFinalized, isClaimed] = postReportStatuses[i];
      expect(amountOfStETH).to.equal(statuses[i][0]); // amountOfStETH remains unchanged
      expect(amountOfShares).to.equal(statuses[i][1]); // amountOfShares remains unchanged
      expect(owner).to.equal(holder.address);
      expect(isFinalized).to.be.true;
      expect(isClaimed).to.be.false;
      expect(postReportClaimableEther[i]).to.be.closeTo(REQUEST_AMOUNT, 2n);
    });

    // Claim withdrawals
    const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);
    const balanceBefore = await ethers.provider.getBalance(holder.address);

    const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
    const receipt = await claimTx.wait();
    const balanceAfter = await ethers.provider.getBalance(holder.address);

    // Verify claim results
    const gasCost = receipt!.gasUsed * receipt!.gasPrice;
    expect(balanceAfter - balanceBefore + gasCost).to.be.closeTo(REQUESTS_SUM, 2n * REQUESTS_COUNT);

    const claimEvents = findEventsWithInterfaces(receipt!, "WithdrawalClaimed", [wq.interface]);
    expect(claimEvents?.length).to.equal(REQUESTS_COUNT);

    claimEvents?.forEach((event, i) => {
      expect(event?.args.requestId).to.equal(BigInt(i) + lastRequestId + 1n);
      expect(event?.args.receiver).to.equal(holder.address);
      expect(event?.args.owner).to.equal(holder.address);
      expect(event?.args.amountOfETH).to.be.closeTo(REQUEST_AMOUNT, 2n);
    });

    // Verify NFT transfers
    const claimTransferEvents = findEventsWithInterfaces(receipt!, "Transfer", [wq.interface], 3);
    expect(claimTransferEvents?.length).to.equal(REQUESTS_COUNT);
    claimTransferEvents?.forEach((event, i) => {
      expect(event?.args.tokenId).to.equal(BigInt(i) + lastRequestId + 1n);
      expect(event?.args.to).to.equal(ethers.ZeroAddress);
      expect(event?.args.from).to.equal(holder.address);
    });

    // Verify final state
    const postClaimStatuses = await wq.getWithdrawalStatus([...requestIds]);
    const postClaimClaimableEther = await wq.getClaimableEther([...requestIds], [...hints]);

    requestIds.forEach((requestId, i) => {
      expect(requestId).to.equal(BigInt(i) + lastRequestId + 1n);
      const [amountOfStETH, amountOfShares, owner, , isFinalized, isClaimed] = postClaimStatuses[i];
      expect(amountOfStETH).to.equal(statuses[i][0]);
      expect(amountOfShares).to.equal(statuses[i][1]);
      expect(owner).to.equal(holder.address);
      expect(isFinalized).to.be.true;
      expect(isClaimed).to.be.true;
      expect(postClaimClaimableEther[i]).to.equal(0);
    });
  });
});
