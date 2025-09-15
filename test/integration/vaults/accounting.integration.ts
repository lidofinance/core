import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { finalizeWQViaElVault } from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: accounting", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;

  before(async () => {
    ctx = await getProtocolContext();
    const { stakingVaultFactory } = ctx.contracts;
    vaultHub = ctx.contracts.vaultHub;
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, stranger] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    agentSigner = await ctx.getSigner("agent");

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    await dashboard.fund({ value: ether("100") });
    await dashboard.mintShares(owner, await dashboard.remainingMintingCapacityShares(0n));

    await ctx.contracts.lido.connect(stranger).submit(owner.address, { value: ether("100") });

    await finalizeWQViaElVault(ctx);
    await reportVaultDataWithProof(ctx, stakingVault);

    await setBalance(ctx.contracts.elRewardsVault.address, 0);
    await setBalance(ctx.contracts.withdrawalVault.address, 0);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  context("Withdrawals: finalization with external shares", () => {
    it("Should finalize requests from withdrawal vault using force rebalance", async () => {
      const withdrawalRequestAmount = ether("10");
      const { withdrawalQueue, lido } = ctx.contracts;
      const stakingVaultAddress = await stakingVault.getAddress();

      await lido.connect(owner).approve(withdrawalQueue.address, withdrawalRequestAmount);
      await lido.connect(stranger).approve(withdrawalQueue.address, withdrawalRequestAmount);

      const firstRequestTx = await withdrawalQueue
        .connect(owner)
        .requestWithdrawals([withdrawalRequestAmount], owner.address);
      const secondRequestTx = await withdrawalQueue
        .connect(stranger)
        .requestWithdrawals([withdrawalRequestAmount], stranger.address);

      const firstRequestReceipt = await firstRequestTx.wait();
      const secondRequestReceipt = await secondRequestTx.wait();

      const [firstRequestEvent] = findEventsWithInterfaces(firstRequestReceipt!, "WithdrawalRequested", [
        withdrawalQueue.interface,
      ]);
      const [secondRequestEvent] = findEventsWithInterfaces(secondRequestReceipt!, "WithdrawalRequested", [
        withdrawalQueue.interface,
      ]);

      const firstRequest = firstRequestEvent!.args.requestId;
      const secondRequest = secondRequestEvent!.args.requestId;

      let [firstStatus, secondStatus] = await withdrawalQueue.getWithdrawalStatus([firstRequest, secondRequest]);

      expect(firstStatus.isFinalized).to.be.false;
      expect(secondStatus.isFinalized).to.be.false;

      // Set balance to cover only first request
      await setBalance(ctx.contracts.lido.address, withdrawalRequestAmount);

      await expect(report(ctx, { clDiff: 0n })).to.be.reverted;

      const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);

      await vaultHub.connect(agentSigner).setLiabilitySharesTarget(stakingVaultAddress, 0n);
      const forceRebalanceTx = await vaultHub.connect(agentSigner).forceRebalance(stakingVaultAddress);

      const forceRebalanceReceipt = await forceRebalanceTx.wait();
      const [rebalanceEvent] = findEventsWithInterfaces(forceRebalanceReceipt!, "VaultRebalanced", [
        vaultHub.interface,
      ]);
      const rebalancedValue = rebalanceEvent!.args.etherWithdrawn;

      await report(ctx, { clDiff: 0n });

      const balanceAfter = await ethers.provider.getBalance(stakingVault);

      [firstStatus, secondStatus] = await withdrawalQueue.getWithdrawalStatus([firstRequest, secondRequest]);

      expect(firstStatus.isFinalized).to.be.true;
      expect(secondStatus.isFinalized).to.be.true;

      const balanceWithdrawn = balanceBefore - balanceAfter;

      expect(balanceWithdrawn).to.equal(rebalancedValue);
      expect(rebalancedValue).to.be.gte(withdrawalRequestAmount);
    });
  });
});
