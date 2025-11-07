import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { BigIntMath, days, DISCONNECT_NOT_INITIATED } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub Force Disconnect", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agentSigner: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let vaultMaster: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);
    [, owner, nodeOperator, vaultMaster] = await ethers.getSigners();

    await setUpOperatorGrid(ctx, [nodeOperator]);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
    vaultHub = ctx.contracts.vaultHub;

    await changeTier(ctx, dashboard, owner, nodeOperator);

    // Grant VAULT_MASTER_ROLE to vaultMaster
    await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultMaster);

    agentSigner = await ctx.getSigner("agent");

    // set maximum fee rate per second to 1 ether to allow rapid fee increases
    await ctx.contracts.lazyOracle.connect(agentSigner).updateSanityParams(days(30n), 1000n, 1000000000000000000n);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("VAULT_MASTER_ROLE can force disconnect", () => {
    for (const feePercent of [50n, 100n, 150n]) {
      it(`disconnects when fee is ${feePercent}% of the vault balance`, async () => {
        const vaultBalance = await ethers.provider.getBalance(stakingVault);
        const feesToSettle = (vaultBalance * feePercent) / 100n;

        // Setup: Connected vault with liabilityShares = 0, fresh report, unsettled fees < balance
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("1"),
          cumulativeLidoFees: feesToSettle, // Create some unsettled fees
        });

        // Verify initial state
        expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);
        expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
        const unsettledFees = await vaultHub.obligations(stakingVault);
        expect(unsettledFees.feesToSettle).to.be.equal(feesToSettle);

        const treasuryBalanceBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

        // Action: VAULT_MASTER_ROLE calls disconnect(vault)
        const tx = await vaultHub.connect(vaultMaster).disconnect(stakingVault);
        await expect(tx).to.emit(vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

        // Expected: disconnectInitiatedTs = block.timestamp
        const receipt = await tx.wait();
        const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))?.timestamp || 0n;
        const connection = await vaultHub.vaultConnection(stakingVault);
        expect(connection.disconnectInitiatedTs).to.equal(BigInt(blockTimestamp));

        const settleAmount = BigIntMath.min(vaultBalance, feesToSettle);
        const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
        expect(treasuryAfter).to.be.equal(treasuryBalanceBefore + settleAmount);
        expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.be.equal(
          vaultBalance - settleAmount,
        );

        // Verify vault is pending disconnect
        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

        await expect(
          reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1"), cumulativeLidoFees: feesToSettle }),
        )
          .to.emit(vaultHub, "VaultDisconnectCompleted")
          .withArgs(stakingVault);

        // Expected: vault is disconnected
        expect((await ctx.contracts.operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(0n);
        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);
      });
    }
  });

  describe("Force disconnect aborted by slashing reserve", () => {
    it("aborts disconnect when slashing reserve appears", async () => {
      // Setup: Initiate disconnect
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        liabilityShares: 0n,
      });

      await vaultHub.connect(vaultMaster).disconnect(stakingVault);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
      const connectionBefore = await vaultHub.vaultConnection(stakingVault);
      const disconnectTs = connectionBefore.disconnectInitiatedTs;
      expect(disconnectTs).to.be.greaterThan(0n);

      // Action: Oracle reports with slashing reserve
      const slashingReserve = ether("0.5");
      const tx = await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        liabilityShares: 0n,
        slashingReserve,
      });

      // Expected: Disconnect aborted
      await expect(tx).to.emit(vaultHub, "VaultDisconnectAborted").withArgs(stakingVault, slashingReserve);

      // Verify disconnect was cancelled
      const connectionAfter = await vaultHub.vaultConnection(stakingVault);
      expect(connectionAfter.disconnectInitiatedTs).to.equal(DISCONNECT_NOT_INITIATED);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;

      // Verify vault remains connected
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
      expect((await ctx.contracts.operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.greaterThan(0n);
    });
  });

  // describe("Force disconnect aborted by socialized bad debt", () => {
  //   let stakingVaultB: StakingVault;
  //   let dashboardB: Dashboard;

  //   beforeEach(async () => {
  //     // Create second vault for bad debt scenario
  //     ({ stakingVault: stakingVaultB, dashboard: dashboardB } = await createVaultWithDashboard(
  //       ctx,
  //       ctx.contracts.stakingVaultFactory,
  //       owner,
  //       nodeOperator,
  //     ));

  //     dashboardB = dashboardB.connect(owner);
  //     await changeTier(ctx, dashboardB, owner, nodeOperator);

  //     // Grant BAD_DEBT_MASTER_ROLE
  //     await vaultHub.connect(agentSigner).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), agentSigner);
  //   });

  // it("aborts disconnect when bad debt is socialized to vault", async () => {
  //   // Setup Vault B: Create bad debt
  //   await dashboardB.fund({ value: ether("10") });
  //   await reportVaultDataWithProof(ctx, stakingVaultB, {
  //     totalValue: ether("11"),
  //     liabilityShares: 0n,
  //   });
  //   await dashboardB.mintStETH(owner, ether("5"));
  //   await reportVaultDataWithProof(ctx, stakingVaultB, {
  //     totalValue: ether("1"), // Slashed from 11 to 1
  //     slashingReserve: ether("1"),
  //     waitForNextRefSlot: true,
  //   });

  //   // Verify Vault B has bad debt
  //   const liabilitySharesB = await vaultHub.liabilityShares(stakingVaultB);
  //   const totalValueB = await vaultHub.totalValue(stakingVaultB);
  //   const liabilityValueB = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilitySharesB);
  //   expect(liabilityValueB).to.be.greaterThan(totalValueB);

  //   // Fund Vault A to accept bad debt
  //   // Setup Vault A: Clean and pending disconnect
  //   const reportTx = await reportVaultDataWithProof(ctx, stakingVault, {
  //     totalValue: ether("1"),
  //     liabilityShares: 0n,
  //   });
  //   await reportTx.wait();
  //   console.log("report timestamp", await ctx.contracts.lazyOracle.latestReportTimestamp());
  //   await vaultHub.connect(vaultMaster).disconnect(stakingVault);
  //   expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
  //   expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);
  //   await dashboard.fund({ value: ether("10") });

  //   // Calculate bad debt shares
  //   const badDebtShares = liabilitySharesB - (await ctx.contracts.lido.getSharesByPooledEth(totalValueB));

  //   expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
  //   expect(await vaultHub.isVaultConnected(stakingVaultB)).to.be.true;
  //   console.log("socialize bad debt timestamp", await ctx.contracts.lazyOracle.latestReportTimestamp());
  //   await vaultHub.connect(agentSigner).socializeBadDebt(stakingVaultB, stakingVault, badDebtShares);

  //   // Verify Vault A now has liability
  //   expect(await vaultHub.liabilityShares(stakingVault)).to.be.greaterThan(0n);

  //   // Action: Oracle reports vault A
  //   const tx = await reportVaultDataWithProof(ctx, stakingVault, {
  //     totalValue: ether("11"),
  //     waitForNextRefSlot: true,
  //   });

  //   // Expected: Disconnect aborted due to liability
  //   await expect(tx).to.emit(vaultHub, "VaultDisconnectAborted");

  //   // Verify disconnect was cancelled
  //   expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
  //   const connection = await vaultHub.vaultConnection(stakingVault);
  //   expect(connection.disconnectInitiatedTs).to.equal(0n);

  //   // Verify vault remains connected
  //   expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
  // });
  // });

  describe("Force disconnect blocks new minting after initiation", () => {
    // it("prevents minting after disconnect is initiated", async () => {
    //   // Setup: Fund vault and initiate disconnect
    //   await dashboard.fund({ value: ether("10") });
    //   await reportVaultDataWithProof(ctx, stakingVault, {
    //     totalValue: ether("11"),
    //   });
    //   await vaultHub.connect(vaultMaster).disconnect(stakingVault);
    //   expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    //   // Action: Attempt to mint after disconnect initiated
    //   // Expected: Should revert
    //   await expect(dashboard.mintStETH(owner, ether("1"))).to.be.revertedWithCustomError(
    //     vaultHub,
    //     "VaultDisconnectPending",
    //   );
    // });
  });

  describe("Voluntary disconnect requires full fee settlement", () => {
    it("settles all fees when doing voluntary disconnect", async () => {
      // Setup: Create unsettled fees
      const unsettledFees = ether("0.5");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        cumulativeLidoFees: unsettledFees,
      });

      // Ensure vault has enough balance to settle fees
      await dashboard.fund({ value: ether("1") });

      const vaultBalance = await ethers.provider.getBalance(stakingVault);
      expect(vaultBalance).to.be.greaterThanOrEqual(unsettledFees);

      const treasuryBalanceBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

      // Action: Voluntary disconnect
      const tx = await dashboard.voluntaryDisconnect();
      await expect(tx).to.emit(vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

      // Expected: All fees settled
      const treasuryBalanceAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
      expect(treasuryBalanceAfter - treasuryBalanceBefore).to.equal(unsettledFees);

      // Verify no unsettled fees remain
      const obligations = await vaultHub.obligations(stakingVault);
      expect(obligations.feesToSettle).to.equal(0n);

      // Verify disconnect was initiated
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    });

    // it("reverts voluntary disconnect when fees cannot be fully settled", async () => {
    //   // Setup: Create unsettled fees greater than vault balance
    //   const unsettledFees = ether("5");
    //   await reportVaultDataWithProof(ctx, stakingVault, {
    //     totalValue: ether("1"),
    //     cumulativeLidoFees: unsettledFees,
    //   });

    //   // Drain vault so it can't pay fees
    //   const currentBalance = await ethers.provider.getBalance(stakingVault);
    //   if (currentBalance > 0n) {
    //     await dashboard.recoverFeeLeftover();
    //   }
    // });
  });
});
