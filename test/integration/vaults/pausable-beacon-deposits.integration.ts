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

describe("Integration: Vault hub beacon deposits pause flows", () => {
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

  context("Manual pause", () => {
    it("Pause beacon deposits manually", async () => {
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      await expect(dashboard.pauseBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(stakingVaultAddress, true)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.true;

      await expect(dashboard.pauseBeaconChainDeposits()).to.be.revertedWithCustomError(
        vaultHub,
        "PauseIntentAlreadySet",
      );
    });

    it("Resume beacon deposits manually", async () => {
      await dashboard.pauseBeaconChainDeposits(); // Pause first

      await expect(dashboard.resumeBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(stakingVaultAddress, false)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;

      await expect(dashboard.resumeBeaconChainDeposits()).to.be.revertedWithCustomError(
        vaultHub,
        "PauseIntentAlreadyUnset",
      );
    });
  });

  context("Automatic pause", () => {
    it("Pause beacon deposits on vault report (big fees >= 1 ether)", async () => {
      await expect(reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("1") })).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;
    });

    it("Pause and resume beacon deposits on redemptions accruance and rebalancing", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintStETH(agentSigner, ether("1"));

      await setBalance(await stakingVault.getAddress(), ether("1") - 1n); // simulate lower than redemption balance

      // +1n to make sure to have >= 1 ether to pause the vault beacon deposits
      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(stakingVaultAddress, 0n)).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      await dashboard.fund({ value: ether("1") });

      await expect(vaultHub.forceRebalance(stakingVaultAddress)).to.emit(stakingVault, "BeaconChainDepositsResumed");
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
    });

    it("Correctly handles paused beacon deposits when paused by owner", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintStETH(agentSigner, ether("1"));

      await setBalance(await stakingVault.getAddress(), ether("1") - 1n); // simulate lower than redemption balance

      // +1n to make sure to have >= 1 ether to pause the vault beacon deposits
      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(stakingVaultAddress, 0n)).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;

      // Pause by owner
      await expect(dashboard.pauseBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(stakingVaultAddress, true)
        .and.not.emit(stakingVault, "BeaconChainDepositsPaused"); // already paused by report

      // Check that owner now pauses the vault
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).beaconChainDepositsPauseIntent).to.be.true;

      await dashboard.fund({ value: ether("1") });

      // Check that even if obligation settled vault is still paused
      await expect(vaultHub.forceRebalance(stakingVaultAddress)).to.not.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).beaconChainDepositsPauseIntent).to.be.true;

      // Check that owner can resume beacon deposits
      await expect(dashboard.resumeBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(stakingVaultAddress, false)
        .to.emit(stakingVault, "BeaconChainDepositsResumed"); // should not be resumed by report

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).beaconChainDepositsPauseIntent).to.be.false;
    });

    it("Correctly handles paused beacon deposits when allowed by owner", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintStETH(agentSigner, ether("1"));

      await setBalance(await stakingVault.getAddress(), ether("1") - 1n); // simulate lower than redemption balance

      // +1n to make sure to have >= 1 ether to pause the vault beacon deposits
      await expect(vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(stakingVaultAddress, 0n)).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      const connection = await vaultHub.vaultConnection(stakingVaultAddress);
      expect(connection.beaconChainDepositsPauseIntent).to.be.false;

      // Pause by owner
      await expect(dashboard.pauseBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(stakingVaultAddress, true)
        .and.not.emit(stakingVault, "BeaconChainDepositsPaused"); // already paused by report

      // Check that owner now pauses the vault
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).beaconChainDepositsPauseIntent).to.be.true;

      await dashboard.fund({ value: ether("1") });

      await expect(dashboard.resumeBeaconChainDeposits())
        .to.emit(vaultHub, "BeaconChainDepositsPauseIntentSet")
        .withArgs(stakingVaultAddress, false)
        .and.not.to.emit(stakingVault, "BeaconChainDepositsResumed");

      // Check that vault is resumed automatically as owner allowed it
      await expect(vaultHub.forceRebalance(stakingVaultAddress)).to.emit(stakingVault, "BeaconChainDepositsResumed");

      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
      expect((await vaultHub.vaultConnection(stakingVaultAddress)).beaconChainDepositsPauseIntent).to.be.false;
    });
  });
});
