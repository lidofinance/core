import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance, time } from "@nomicfoundation/hardhat-network-helpers";

import { Lido, WithdrawalQueueERC721 } from "typechain-types";

import { ether, findEventsWithInterfaces } from "lib";
import { finalizeWQViaSubmit, getProtocolContext, ProtocolContext, report } from "lib/protocol";
import { finalizeWQViaElVault } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

describe("Integration: Withdrawal edge cases", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalState: string;

  let holder: HardhatEthersSigner;
  let lido: Lido;
  let wq: WithdrawalQueueERC721;

  before(async () => {
    ctx = await getProtocolContext();
    lido = ctx.contracts.lido;
    wq = ctx.contracts.withdrawalQueue;

    snapshot = await Snapshot.take();

    [, holder] = await ethers.getSigners();
    await setBalance(holder.address, ether("1000000"));

    await finalizeWQViaSubmit(ctx);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));
  after(async () => await Snapshot.restore(snapshot));

  it("Should handle bunker mode with multiple batches", async () => {
    await finalizeWQViaElVault(ctx);

    const amount = ether("100");
    const withdrawalAmount = ether("10");

    expect(await lido.balanceOf(holder.address)).to.equal(0);

    await lido.connect(holder).approve(wq.target, amount);
    await lido.connect(holder).submit(ethers.ZeroAddress, { value: amount });

    const stethInitialBalance = await lido.balanceOf(holder.address);

    await report(ctx, { clDiff: ether("-1"), excludeVaultsBalances: true });

    const stethFirstNegativeReportBalance = await lido.balanceOf(holder.address);

    expect(stethInitialBalance).to.be.gt(stethFirstNegativeReportBalance);
    expect(await wq.isBunkerModeActive()).to.be.true;

    // First withdrawal request
    const firstRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
    const firstRequestReceipt = await firstRequestTx.wait();
    const [firstRequestEvent] = findEventsWithInterfaces(firstRequestReceipt!, "WithdrawalRequested", [wq.interface]);
    const firstRequestId = firstRequestEvent!.args.requestId;

    await report(ctx, { clDiff: ether("-0.1"), excludeVaultsBalances: true });

    const stethSecondNegativeReportBalance = await lido.balanceOf(holder.address);

    expect(stethFirstNegativeReportBalance).to.be.gt(stethSecondNegativeReportBalance);
    expect(await wq.isBunkerModeActive()).to.be.true;

    // Second withdrawal request
    const secondRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
    const secondRequestReceipt = await secondRequestTx.wait();
    const [secondRequestEvent] = findEventsWithInterfaces(secondRequestReceipt!, "WithdrawalRequested", [wq.interface]);
    const secondRequestId = secondRequestEvent!.args.requestId;

    const requestIds = [firstRequestId, secondRequestId];
    const [firstStatus, secondStatus] = await wq.getWithdrawalStatus([...requestIds]);

    // Amount of requested ETH should be equal, but shares are different
    // because second request was affected by negative rebase twice
    expect(firstStatus.amountOfStETH).to.equal(secondStatus.amountOfStETH);
    expect(firstStatus.amountOfShares).to.be.lt(secondStatus.amountOfShares);

    await report(ctx, { clDiff: ether("0.0001"), excludeVaultsBalances: true });

    expect(await wq.isBunkerModeActive()).to.be.false;

    const statuses = await wq.getWithdrawalStatus([...requestIds]);
    statuses.forEach((status) => {
      expect(status.isFinalized).to.be.true;
    });

    const lastCheckpointIndex = await wq.getLastCheckpointIndex();
    const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);

    const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
    const claimReceipt = await claimTx.wait();

    // First claimed request should be less than requested amount because it caught negative rebase
    const claimEvents = findEventsWithInterfaces(claimReceipt!, "WithdrawalClaimed", [wq.interface]);
    expect(claimEvents![0].args.amountOfETH).to.be.lt(withdrawalAmount);
    expect(claimEvents![1].args.amountOfETH).to.equal(withdrawalAmount);
  });

  it("should handle missed oracle report", async () => {
    await finalizeWQViaElVault(ctx);

    const amount = ether("100");

    expect(await lido.balanceOf(holder.address)).to.equal(0);

    // Submit initial stETH deposit
    await lido.connect(holder).submit(ethers.ZeroAddress, { value: amount });

    await report(ctx, { clDiff: ether("0.001"), excludeVaultsBalances: true });

    // Create withdrawal request
    await lido.connect(holder).approve(wq.target, amount);
    const requestTx = await wq.connect(holder).requestWithdrawals([amount], holder.address);
    const requestReceipt = await requestTx.wait();
    const [requestEvent] = findEventsWithInterfaces(requestReceipt!, "WithdrawalRequested", [wq.interface]);
    const requestId = requestEvent!.args.requestId;
    const requestIds = [requestId];

    // Skip next report by waiting extra time
    const timeBeforeMissedReport = await time.latest();
    await time.increase(24 * 60 * 60); // 24 hours
    const timeAfterMissedReport = await time.latest();

    // Check request not finalized after missed report
    const [status] = await wq.getWithdrawalStatus([...requestIds]);
    expect(timeBeforeMissedReport).to.be.lt(timeAfterMissedReport);
    expect(status.isFinalized).to.be.false;

    // Submit next report to finalize request
    await report(ctx, { clDiff: ether("0.001"), excludeVaultsBalances: true });

    // Verify request finalized
    const [finalizedStatus] = await wq.getWithdrawalStatus([...requestIds]);
    expect(finalizedStatus.isFinalized).to.be.true;

    // Claim withdrawal
    const lastCheckpointIndex = await wq.getLastCheckpointIndex();
    const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);
    const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
    const claimReceipt = await claimTx.wait();

    // Verify claimed amount matches requested amount
    const claimEvents = findEventsWithInterfaces(claimReceipt!, "WithdrawalClaimed", [wq.interface]);
    expect(claimEvents![0].args.amountOfETH).to.equal(amount);
  });

  it("should handle several rebases correctly", async () => {
    await finalizeWQViaElVault(ctx);

    const amount = ether("100");
    const withdrawalAmount = ether("10");

    expect(await lido.balanceOf(holder.address)).to.equal(0);

    await lido.connect(holder).approve(wq.target, amount);
    await lido.connect(holder).submit(ethers.ZeroAddress, { value: amount });

    const requestIds: bigint[] = [];

    // First rebase - positive
    await report(ctx, { clDiff: ether("0.001"), excludeVaultsBalances: true });

    // Create first withdrawal request
    const firstRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
    const firstRequestReceipt = await firstRequestTx.wait();
    const [firstRequestEvent] = findEventsWithInterfaces(firstRequestReceipt!, "WithdrawalRequested", [wq.interface]);
    requestIds.push(firstRequestEvent!.args.requestId);

    // Second rebase - negative
    await report(ctx, { clDiff: ether("-0.1"), excludeVaultsBalances: true });
    expect(await wq.isBunkerModeActive()).to.be.true;

    // Verify first request finalized
    const [firstStatus] = await wq.getWithdrawalStatus([requestIds[0]]);
    expect(firstStatus.isFinalized).to.be.true;

    // Create second withdrawal request
    const secondRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
    const secondRequestReceipt = await secondRequestTx.wait();
    const [secondRequestEvent] = findEventsWithInterfaces(secondRequestReceipt!, "WithdrawalRequested", [wq.interface]);
    requestIds.push(secondRequestEvent!.args.requestId);

    // Third rebase - negative
    await report(ctx, { clDiff: ether("-0.1"), excludeVaultsBalances: true });
    expect(await wq.isBunkerModeActive()).to.be.true;

    // Create third withdrawal request
    const thirdRequestTx = await wq.connect(holder).requestWithdrawals([withdrawalAmount], holder.address);
    const thirdRequestReceipt = await thirdRequestTx.wait();
    const [thirdRequestEvent] = findEventsWithInterfaces(thirdRequestReceipt!, "WithdrawalRequested", [wq.interface]);
    requestIds.push(thirdRequestEvent!.args.requestId);

    // Fourth rebase - positive
    await report(ctx, { clDiff: ether("0.0000001"), excludeVaultsBalances: true });
    expect(await wq.isBunkerModeActive()).to.be.false;

    // Verify all requests finalized
    const statuses = await wq.getWithdrawalStatus(requestIds);
    for (const status of statuses) {
      expect(status.isFinalized).to.be.true;
    }

    // Claim withdrawals
    const lastCheckpointIndex = await wq.getLastCheckpointIndex();
    const hints = await wq.findCheckpointHints([...requestIds], 1, lastCheckpointIndex);
    const claimTx = await wq.connect(holder).claimWithdrawals([...requestIds], [...hints]);
    const claimReceipt = await claimTx.wait();

    // Verify claimed amounts
    const claimEvents = findEventsWithInterfaces(claimReceipt!, "WithdrawalClaimed", [wq.interface]);
    expect(claimEvents![0].args.amountOfETH).to.be.lt(withdrawalAmount);
    expect(claimEvents![1].args.amountOfETH).to.be.lt(withdrawalAmount);
    expect(claimEvents![2].args.amountOfETH).to.equal(withdrawalAmount);
  });
});
