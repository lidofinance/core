import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Vault hub beacon deposits pause flows", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;
  let snapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let stakingVaultAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub } = ctx.contracts);

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

    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
  });

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  context("Manual pause", () => {
    it("Pause beacon deposits manually", async () => {
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      await expect(dashboard.pauseBeaconChainDeposits())
        .to.emit(stakingVault, "BeaconChainDepositsPaused")
        .and.to.emit(vaultHub, "BeaconChainDepositsPausedByOwner");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.true;

      await expect(dashboard.pauseBeaconChainDeposits()).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");
    });

    it("Resume beacon deposits manually", async () => {
      await dashboard.pauseBeaconChainDeposits(); // Pause first

      await expect(dashboard.resumeBeaconChainDeposits())
        .to.emit(stakingVault, "BeaconChainDepositsResumed")
        .and.to.emit(vaultHub, "BeaconChainDepositsResumedByOwner");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;

      await expect(dashboard.resumeBeaconChainDeposits()).to.be.revertedWithCustomError(vaultHub, "PausedExpected");
    });
  });

  context("Automatic pause", () => {
    it("Pause beacon deposits on vault report (big fees)", async () => {
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") })).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.isBeaconDepositsManuallyPaused).to.be.false;
    });

    it("Pause and resume beacon deposits on redemptions accruance and rebalancing", async () => {
      await dashboard.fund({ value: ether("2") });
      await dashboard.mintStETH(agentSigner, ether("2"));

      // +1n to make sure to have >= 1 ether to pause the vault beacon deposits
      const redemptionShares = await ctx.contracts.lido.getSharesByPooledEth(ether("1"));
      await expect(
        vaultHub.connect(redemptionMaster).updateRedemptionShares(stakingVaultAddress, redemptionShares + 1n),
      ).to.emit(stakingVault, "BeaconChainDepositsPaused");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      await dashboard.fund({ value: ether("1") });

      await expect(vaultHub.forceRebalance(stakingVaultAddress)).to.emit(stakingVault, "BeaconChainDepositsResumed");
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });

    it.skip("Unpauses beacon deposits on report when paused by report", async () => {
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") })).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      await dashboard.fund({ value: ether("1") });

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") })).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );
    });

    it("Correctly handles paused beacon deposits when paused by owner", async () => {
      const lidoFees = ether("1");
      // Pause by report
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: lidoFees })).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).isBeaconDepositsManuallyPaused).to.be.false;

      // Pause by owner
      await expect(dashboard.pauseBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPausedByOwner")
        .and.not.emit(stakingVault, "BeaconChainDepositsPaused"); // already paused by report

      // Check that owner now pauses the vault
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).isBeaconDepositsManuallyPaused).to.be.true;

      await dashboard.fund({ value: lidoFees });

      // Check that even if obligation settled vault is still paused
      await expect(vaultHub.payLidoFees(stakingVaultAddress))
        .to.emit(vaultHub, "LidoFeesSettled")
        .withArgs(stakingVaultAddress, lidoFees, 0, lidoFees)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).isBeaconDepositsManuallyPaused).to.be.true;

      // Check that owner can resume beacon deposits
      await expect(dashboard.resumeBeaconChainDeposits())
        .to.emit(stakingVault, "BeaconChainDepositsResumed") // should not be resumed by report
        .and.to.emit(vaultHub, "BeaconChainDepositsResumedByOwner");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).isBeaconDepositsManuallyPaused).to.be.false;
    });
  });
});
