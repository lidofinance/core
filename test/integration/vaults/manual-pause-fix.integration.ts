import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";
import { Dashboard, LazyOracle, StakingVault, VaultHub } from "typechain-types";
import { days, ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { Snapshot } from "test/suite";

describe("Integration: Manual Pause Flag Fix - Issue Resolution", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;
  let snapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let lazyOracle: LazyOracle;

  let stakingVaultAddress: string;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();
    await setupLidoForVaults(ctx);
    ({ vaultHub, lazyOracle } = ctx.contracts);
    [owner, nodeOperator, redemptionMaster] = await ethers.getSigners();

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
    stakingVaultAddress = await stakingVault.getAddress();
    agentSigner = await ctx.getSigner("agent");

    await lazyOracle.connect(agentSigner).updateSanityParams(days(30n), 1000n, 1000000000000000000n);
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
  });

  after(async () => await Snapshot.restore(originalSnapshot));
  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));

  context("Issue Resolution: Manual pause flag control with redemptions", () => {
    beforeEach(async () => {
      // Create a scenario with redemptions that would prevent normal resumption
      await dashboard.fund({ value: ether("2") });
      await dashboard.mintStETH(agentSigner, ether("1"));
      
      // Simulate vault having insufficient balance to cover redemptions
      await setBalance(await stakingVault.getAddress(), ether("0.5"));
      
      // Create redemptions by setting liability shares target to 0
      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(stakingVaultAddress, 0n))
        .to.emit(stakingVault, "BeaconChainDepositsPaused"); // Should auto-pause due to redemptions
      
      // Manually pause deposits 
      await dashboard.pauseBeaconChainDeposits();
      
      // Verify initial state
      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      const record = await vaultHub.vaultRecord(stakingVaultAddress);
      
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
      expect(record.redemptionShares).to.be.gt(0);
    });

    it("OLD BEHAVIOR: resumeBeaconChainDeposits fails with redemptions", async () => {
      // This demonstrates the original issue - can't set manual pause flag to false
      // when there are redemptions
      await expect(dashboard.resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(vaultHub, "HasRedemptionsCannotDeposit");
      
      // Flag remains true, preventing automatic resumption later
      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;
    });

    it("NEW BEHAVIOR: setBeaconDepositsManuallyPaused allows flag control despite redemptions", async () => {
      // This demonstrates the fix - can set manual pause flag to false even with redemptions
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.emit(vaultHub, "BeaconChainDepositsResumedByOwner")
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed"); // Should NOT actually resume yet due to redemptions
      
      // Manual flag is now false, but deposits still paused due to redemptions
      let connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
      
      // Now resolve the redemptions by funding the vault
      await dashboard.fund({ value: ether("2") });
      
      // Force rebalance should now resume deposits automatically because manual flag is false
      await expect(vaultHub.forceRebalance(stakingVaultAddress))
        .to.emit(stakingVault, "BeaconChainDepositsResumed");
      
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
      
      connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
    });

    it("Manual flag prevents automatic resumption even after redemptions resolved", async () => {
      // If manual flag stays true, deposits won't auto-resume even after conditions improve
      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;
      
      // Resolve redemptions
      await dashboard.fund({ value: ether("2") });
      
      // Force rebalance should NOT resume deposits because manual flag is true
      await expect(vaultHub.forceRebalance(stakingVaultAddress))
        .to.not.emit(stakingVault, "BeaconChainDepositsResumed");
      
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });
  });

  context("Issue Resolution: Manual pause flag control with high fees", () => {
    it("Can set manual pause flag to false despite high unsettled fees", async () => {
      // Create high fees that would prevent normal resumption
      await expect(reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("1.5") }))
        .to.emit(stakingVault, "BeaconChainDepositsPaused");
      
      // Manually pause
      await dashboard.pauseBeaconChainDeposits();
      
      // Verify we have high fees
      const record = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(record.cumulativeLidoFees - record.settledLidoFees).to.be.gte(ether("1"));
      
      // OLD approach would fail
      await expect(dashboard.resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(vaultHub, "FeesTooHighCannotDeposit");
      
      // NEW approach succeeds
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.emit(vaultHub, "BeaconChainDepositsResumedByOwner")
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed"); // Should NOT actually resume yet due to high fees
      
      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true; // Still paused due to fees
    });
  });

  context("Edge cases and error handling", () => {
    it("Reverts when setting same pause state", async () => {
      // Initial state: not manually paused
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.be.revertedWithCustomError(vaultHub, "PausedExpected");
      
      // Pause first
      await dashboard.pauseBeaconChainDeposits();
      
      // Try to pause again
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, true))
        .to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("Works as replacement for existing pause/resume functions", async () => {
      // Can use new function to pause
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, true))
        .to.emit(vaultHub, "BeaconChainDepositsPausedByOwner")
        .and.to.emit(stakingVault, "BeaconChainDepositsPaused");
      
      // Can use new function to resume (when conditions allow)
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.emit(vaultHub, "BeaconChainDepositsResumedByOwner")
        .and.to.emit(stakingVault, "BeaconChainDepositsResumed"); // Should actually resume since no obstacles
      
      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });
  });
});