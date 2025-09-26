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

describe("Manual Pause Fix: Set beacon deposits manually paused flag", () => {
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

    // Owner can create a vault with operator as a node operator
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

    // set maximum fee rate per second to 1 ether to allow rapid fee increases
    await lazyOracle.connect(agentSigner).updateSanityParams(days(30n), 1000n, 1000000000000000000n);

    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
  });

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  context("New setBeaconDepositsManuallyPaused function", () => {
    it("Should allow setting manual pause flag to false even with redemptions", async () => {
      // Setup: Create redemptions that would normally prevent resumption
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintStETH(agentSigner, ether("1"));
      await setBalance(await stakingVault.getAddress(), ether("1") - 1n);

      // Create redemptions by setting liability shares target to 0
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(stakingVaultAddress, 0n);

      // Manually pause the vault first
      await dashboard.pauseBeaconChainDeposits();
      
      let connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Check that we have redemption shares that would normally prevent resumption
      const record = await vaultHub.vaultRecord(stakingVaultAddress);
      expect(record.redemptionShares).to.be.gt(0);

      // Now use the new function to set manual pause to false despite redemptions
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.emit(vaultHub, "BeaconChainDepositsResumedByOwner");
      
      connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
      
      // Deposits should still be paused because of redemptions, but manual flag is false
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
      
      // Now when redemptions are resolved, deposits should auto-resume
      await dashboard.fund({ value: ether("1") });
      await expect(vaultHub.forceRebalance(stakingVaultAddress))
        .to.emit(stakingVault, "BeaconChainDepositsResumed");
      
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });

    it("Should allow setting manual pause flag to false even with high fees", async () => {
      // Setup: Create high fees that would normally prevent resumption
      await expect(reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("1") }))
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      // Manually pause the vault first
      await dashboard.pauseBeaconChainDeposits();
      
      let connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;

      // Now use the new function to set manual pause to false despite high fees
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.emit(vaultHub, "BeaconChainDepositsResumedByOwner");
      
      connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
      
      // Deposits should still be paused because of high fees, but manual flag is false
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("Should revert when setting same pause state", async () => {
      // Try to set paused=false when already false
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, false))
        .to.be.revertedWithCustomError(vaultHub, "PausedExpected");

      // Pause first, then try to set paused=true when already true
      await dashboard.pauseBeaconChainDeposits();
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, true))
        .to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("Should work as a replacement for pauseBeaconChainDeposits", async () => {
      // Use new function to pause
      await expect(vaultHub.connect(owner).setBeaconDepositsManuallyPaused(stakingVaultAddress, true))
        .to.emit(vaultHub, "BeaconChainDepositsPausedByOwner")
        .and.to.emit(stakingVault, "BeaconChainDepositsPaused");

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
    });
  });
});