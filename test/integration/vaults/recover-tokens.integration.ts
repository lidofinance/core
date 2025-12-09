import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, ERC20__Harness, EthRejector, Lido, StakingVault, WstETH } from "typechain-types";

import { ether, impersonate } from "lib";
import {
  autofillRoles,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

// EIP-7528 ETH address
const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

describe("Integration: RecoverTokens in StakingVault and Dashboard", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let erc20Token: ERC20__Harness;
  let stETH: Lido;
  let wstETH: WstETH;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    // Fund the vault for connection
    await dashboard.connect(owner).fund({ value: ether("1") });

    // Autofill roles to have asset collector
    roles = await autofillRoles(dashboard, nodeOperator);

    // Deploy test ERC20 token
    erc20Token = await ethers.deployContract("ERC20__Harness", ["Test Token", "TST"]);

    // Get stETH and wstETH from protocol context
    stETH = ctx.contracts.lido;
    wstETH = ctx.contracts.wstETH;
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("StakingVault.collectERC20", () => {
    const tokenAmount = ether("100");

    beforeEach(async () => {
      // Send ERC20 tokens to the staking vault
      await erc20Token.mint(stakingVault, tokenAmount);
    });

    it("VaultHub is the owner of connected StakingVault", async () => {
      // When a vault is connected to VaultHub, ownership is transferred to VaultHub
      expect(await stakingVault.owner()).to.equal(ctx.contracts.vaultHub);
    });

    it("Reverts when called by stranger directly on StakingVault", async () => {
      await expect(stakingVault.connect(stranger).collectERC20(erc20Token, stranger, tokenAmount))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(stranger);
    });

    it("Reverts when called by Dashboard admin directly on StakingVault (not via VaultHub)", async () => {
      // The Dashboard admin cannot call collectERC20 directly on StakingVault
      // because VaultHub is the owner, not the admin
      await expect(stakingVault.connect(owner).collectERC20(erc20Token, stranger, tokenAmount))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(owner);
    });

    it("Reverts when called by node operator directly on StakingVault", async () => {
      await expect(stakingVault.connect(nodeOperator).collectERC20(erc20Token, stranger, tokenAmount))
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(nodeOperator);
    });
  });

  describe("Dashboard.recoverERC20", () => {
    const tokenAmount = ether("100");

    describe("ERC20 token recovery", () => {
      beforeEach(async () => {
        // Send ERC20 tokens to the dashboard
        await erc20Token.mint(dashboard, tokenAmount);
      });

      it("Allows admin to recover ERC20 tokens from dashboard", async () => {
        const recipientBalanceBefore = await erc20Token.balanceOf(stranger);

        await expect(dashboard.connect(owner).recoverERC20(erc20Token, stranger, tokenAmount))
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(stranger, erc20Token, tokenAmount);

        const recipientBalanceAfter = await erc20Token.balanceOf(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(tokenAmount);
        expect(await erc20Token.balanceOf(dashboard)).to.equal(0n);
      });

      it("Allows admin to recover partial ERC20 tokens", async () => {
        const partialAmount = ether("50");

        await expect(dashboard.connect(owner).recoverERC20(erc20Token, stranger, partialAmount))
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(stranger, erc20Token, partialAmount);

        expect(await erc20Token.balanceOf(stranger)).to.equal(partialAmount);
        expect(await erc20Token.balanceOf(dashboard)).to.equal(tokenAmount - partialAmount);
      });

      it("Reverts when called by non-admin", async () => {
        await expect(
          dashboard.connect(stranger).recoverERC20(erc20Token, stranger, tokenAmount),
        ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
      });

      it("Reverts when token address is zero", async () => {
        await expect(
          dashboard.connect(owner).recoverERC20(ZeroAddress, stranger, tokenAmount),
        ).to.be.revertedWithCustomError(dashboard, "ZeroAddress");
      });

      it("Reverts when recipient address is zero", async () => {
        await expect(
          dashboard.connect(owner).recoverERC20(erc20Token, ZeroAddress, tokenAmount),
        ).to.be.revertedWithCustomError(dashboard, "ZeroAddress");
      });

      it("Reverts when amount is zero", async () => {
        await expect(dashboard.connect(owner).recoverERC20(erc20Token, stranger, 0n)).to.be.revertedWithCustomError(
          dashboard,
          "ZeroArgument",
        );
      });
    });

    describe("stETH token recovery", () => {
      const stETHAmount = ether("10");

      beforeEach(async () => {
        // Get stETH by submitting ETH to Lido
        const staker = await impersonate(stranger.address, stETHAmount * 2n);
        await stETH.connect(staker).submit(staker.address, { value: stETHAmount });

        // Transfer stETH to dashboard (simulating accidental send)
        await stETH.connect(staker).transfer(dashboard, stETHAmount);
      });

      it("Allows admin to recover stETH from dashboard", async () => {
        const dashboardStETHBefore = await stETH.balanceOf(dashboard);
        expect(dashboardStETHBefore).to.be.closeTo(stETHAmount, 2n);

        const recipientBalanceBefore = await stETH.balanceOf(stranger);

        await expect(dashboard.connect(owner).recoverERC20(stETH, stranger, dashboardStETHBefore))
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(stranger, stETH, dashboardStETHBefore);

        const recipientBalanceAfter = await stETH.balanceOf(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.be.closeTo(dashboardStETHBefore, 2n);
      });
    });

    describe("wstETH token recovery", () => {
      const wstETHAmount = ether("5");

      beforeEach(async () => {
        // Get stETH first
        const staker = await impersonate(stranger.address, wstETHAmount * 3n);
        await stETH.connect(staker).submit(staker.address, { value: wstETHAmount * 2n });

        // Approve and wrap to get wstETH
        const stETHBalance = await stETH.balanceOf(staker.address);
        await stETH.connect(staker).approve(wstETH, stETHBalance);
        await wstETH.connect(staker).wrap(stETHBalance);

        // Transfer wstETH to dashboard (simulating accidental send)
        const wstETHBalance = await wstETH.balanceOf(staker.address);
        await wstETH.connect(staker).transfer(dashboard, wstETHBalance);
      });

      it("Allows admin to recover wstETH from dashboard", async () => {
        const dashboardWstETHBefore = await wstETH.balanceOf(dashboard);
        expect(dashboardWstETHBefore).to.be.gt(0n);

        const recipientBalanceBefore = await wstETH.balanceOf(stranger);

        await expect(dashboard.connect(owner).recoverERC20(wstETH, stranger, dashboardWstETHBefore))
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(stranger, wstETH, dashboardWstETHBefore);

        const recipientBalanceAfter = await wstETH.balanceOf(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(dashboardWstETHBefore);
        expect(await wstETH.balanceOf(dashboard)).to.equal(0n);
      });
    });

    describe("ETH recovery", () => {
      const ethAmount = ether("1");

      beforeEach(async () => {
        // Force ETH into the dashboard using hardhat_setBalance
        // This simulates ETH being stuck in the dashboard (e.g., from selfdestruct)
        const dashboardAddress = await dashboard.getAddress();
        const currentBalance = await ethers.provider.getBalance(dashboardAddress);
        const newBalance = currentBalance + ethAmount;
        await setBalance(dashboardAddress, newBalance);
      });

      it("Allows admin to recover ETH from dashboard using EIP-7528 address", async () => {
        const recipientBalanceBefore = await ethers.provider.getBalance(stranger);

        await expect(dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, ethAmount))
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(stranger, ETH_ADDRESS, ethAmount);

        const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(ethAmount);
      });

      it("Allows admin to recover partial ETH", async () => {
        const partialAmount = ether("0.5");

        const recipientBalanceBefore = await ethers.provider.getBalance(stranger);
        const dashboardBalanceBefore = await ethers.provider.getBalance(dashboard);

        await expect(dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, partialAmount))
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(stranger, ETH_ADDRESS, partialAmount);

        const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
        const dashboardBalanceAfter = await ethers.provider.getBalance(dashboard);

        expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(partialAmount);
        expect(dashboardBalanceBefore - dashboardBalanceAfter).to.equal(partialAmount);
      });

      it("Reverts when trying to recover more ETH than available", async () => {
        const excessAmount = ether("10");
        await expect(
          dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, excessAmount),
        ).to.be.revertedWithCustomError(dashboard, "InsufficientBalance");
      });

      it("Reverts when called by non-admin", async () => {
        await expect(
          dashboard.connect(stranger).recoverERC20(ETH_ADDRESS, stranger, ethAmount),
        ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
      });

      it("Reverts with EthTransferFailed when recipient rejects ETH", async () => {
        // Deploy a contract that rejects ETH transfers
        const ethRejector: EthRejector = await ethers.deployContract("EthRejector");

        await expect(dashboard.connect(owner).recoverERC20(ETH_ADDRESS, ethRejector, ethAmount))
          .to.be.revertedWithCustomError(dashboard, "EthTransferFailed")
          .withArgs(ethRejector, ethAmount);
      });
    });
  });

  describe("Dashboard.collectERC20FromVault", () => {
    const tokenAmount = ether("100");

    describe("ERC20 mock token", () => {
      beforeEach(async () => {
        // Send ERC20 tokens to the staking vault
        await erc20Token.mint(stakingVault, tokenAmount);
      });

      it("Allows asset collector role to collect ERC20 tokens from vault", async () => {
        const recipientBalanceBefore = await erc20Token.balanceOf(stranger);

        await expect(dashboard.connect(roles.assetCollector).collectERC20FromVault(erc20Token, stranger, tokenAmount))
          .to.emit(stakingVault, "AssetsRecovered")
          .withArgs(stranger, erc20Token, tokenAmount);

        const recipientBalanceAfter = await erc20Token.balanceOf(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(tokenAmount);
        expect(await erc20Token.balanceOf(stakingVault)).to.equal(0n);
      });

      it("Allows admin to collect ERC20 tokens from vault", async () => {
        await expect(dashboard.connect(owner).collectERC20FromVault(erc20Token, stranger, tokenAmount))
          .to.emit(stakingVault, "AssetsRecovered")
          .withArgs(stranger, erc20Token, tokenAmount);

        expect(await erc20Token.balanceOf(stranger)).to.equal(tokenAmount);
      });

      it("Allows collecting partial ERC20 tokens from vault", async () => {
        const partialAmount = ether("50");

        await expect(dashboard.connect(owner).collectERC20FromVault(erc20Token, stranger, partialAmount))
          .to.emit(stakingVault, "AssetsRecovered")
          .withArgs(stranger, erc20Token, partialAmount);

        expect(await erc20Token.balanceOf(stranger)).to.equal(partialAmount);
        expect(await erc20Token.balanceOf(stakingVault)).to.equal(tokenAmount - partialAmount);
      });

      it("Reverts when called by unauthorized user", async () => {
        await expect(dashboard.connect(stranger).collectERC20FromVault(erc20Token, stranger, tokenAmount))
          .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
          .withArgs(stranger, await dashboard.COLLECT_VAULT_ERC20_ROLE());
      });

      it("Reverts when token address is zero", async () => {
        await expect(
          dashboard.connect(owner).collectERC20FromVault(ZeroAddress, stranger, tokenAmount),
        ).to.be.revertedWithCustomError(stakingVault, "ZeroArgument");
      });

      it("Reverts when recipient address is zero", async () => {
        await expect(
          dashboard.connect(owner).collectERC20FromVault(erc20Token, ZeroAddress, tokenAmount),
        ).to.be.revertedWithCustomError(stakingVault, "ZeroArgument");
      });

      it("Reverts when amount is zero", async () => {
        await expect(
          dashboard.connect(owner).collectERC20FromVault(erc20Token, stranger, 0n),
        ).to.be.revertedWithCustomError(stakingVault, "ZeroArgument");
      });

      it("Reverts when trying to collect ETH via EIP-7528 address", async () => {
        await expect(
          dashboard.connect(owner).collectERC20FromVault(ETH_ADDRESS, stranger, tokenAmount),
        ).to.be.revertedWithCustomError(stakingVault, "EthCollectionNotAllowed");
      });
    });

    describe("stETH token", () => {
      const stETHAmount = ether("10");

      beforeEach(async () => {
        // Get stETH and send to the staking vault
        const staker = await impersonate(stranger.address, stETHAmount * 2n);
        await stETH.connect(staker).submit(staker.address, { value: stETHAmount });
        await stETH.connect(staker).transfer(stakingVault, stETHAmount);
      });

      it("Allows collecting stETH from vault", async () => {
        const vaultStETHBefore = await stETH.balanceOf(stakingVault);
        expect(vaultStETHBefore).to.be.closeTo(stETHAmount, 2n);

        const recipientBalanceBefore = await stETH.balanceOf(stranger);

        await expect(dashboard.connect(owner).collectERC20FromVault(stETH, stranger, vaultStETHBefore))
          .to.emit(stakingVault, "AssetsRecovered")
          .withArgs(stranger, stETH, vaultStETHBefore);

        const recipientBalanceAfter = await stETH.balanceOf(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.be.closeTo(vaultStETHBefore, 2n);
      });
    });

    describe("wstETH token", () => {
      const wstETHAmount = ether("5");

      beforeEach(async () => {
        // Get stETH first
        const staker = await impersonate(stranger.address, wstETHAmount * 3n);
        await stETH.connect(staker).submit(staker.address, { value: wstETHAmount * 2n });

        // Approve and wrap to get wstETH
        const stETHBalance = await stETH.balanceOf(staker.address);
        await stETH.connect(staker).approve(wstETH, stETHBalance);
        await wstETH.connect(staker).wrap(stETHBalance);

        // Transfer wstETH to the staking vault
        const wstETHBalance = await wstETH.balanceOf(staker.address);
        await wstETH.connect(staker).transfer(stakingVault, wstETHBalance);
      });

      it("Allows collecting wstETH from vault", async () => {
        const vaultWstETHBefore = await wstETH.balanceOf(stakingVault);
        expect(vaultWstETHBefore).to.be.gt(0n);

        const recipientBalanceBefore = await wstETH.balanceOf(stranger);

        await expect(dashboard.connect(owner).collectERC20FromVault(wstETH, stranger, vaultWstETHBefore))
          .to.emit(stakingVault, "AssetsRecovered")
          .withArgs(stranger, wstETH, vaultWstETHBefore);

        const recipientBalanceAfter = await wstETH.balanceOf(stranger);
        expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(vaultWstETHBefore);
        expect(await wstETH.balanceOf(stakingVault)).to.equal(0n);
      });
    });
  });

  describe("Dashboard.voluntaryDisconnect and feeLeftover recovery", () => {
    it("collects accrued fees to feeLeftover on voluntaryDisconnect", async () => {
      // Setup: Fund vault to have enough balance for fees
      await dashboard.connect(owner).fund({ value: ether("10") });

      // Simulate rewards by reporting increased totalValue to trigger fee accrual
      const totalValue = ether("15");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue,
        waitForNextRefSlot: true,
      });

      // Check that fees have accrued
      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.be.gt(0n, "Expected accrued fees after value increase");

      // Initial feeLeftover should be 0
      expect(await dashboard.feeLeftover()).to.equal(0n);

      // Perform voluntary disconnect
      const tx = await dashboard.connect(owner).voluntaryDisconnect();

      // Verify disconnect was initiated
      await expect(tx).to.emit(ctx.contracts.vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

      // Verify feeLeftover was set (fees collected to Dashboard)
      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.be.gt(0n, "Expected feeLeftover to be set after voluntaryDisconnect");
    });

    it("allows recovering feeLeftover to feeRecipient after disconnect", async () => {
      // Setup: Fund vault to have enough balance for fees
      await dashboard.connect(owner).fund({ value: ether("10") });

      // Simulate rewards to trigger fee accrual
      const totalValue = ether("15");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue,
        waitForNextRefSlot: true,
      });

      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.be.gt(0n);

      // Perform voluntary disconnect to collect fees to feeLeftover
      await dashboard.connect(owner).voluntaryDisconnect();

      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.be.gt(0n);

      // Complete the disconnection with a report
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue });

      expect(await ctx.contracts.vaultHub.isVaultConnected(stakingVault)).to.be.false;

      // Get fee recipient address
      const feeRecipient = await dashboard.feeRecipient();
      const feeRecipientBalanceBefore = await ethers.provider.getBalance(feeRecipient);

      // Recover the fee leftover
      await expect(dashboard.recoverFeeLeftover())
        .to.emit(dashboard, "AssetsRecovered")
        .withArgs(feeRecipient, ETH_ADDRESS, feeLeftover);

      // Verify feeLeftover is now 0
      expect(await dashboard.feeLeftover()).to.equal(0n);

      // Verify fee recipient received the ETH
      const feeRecipientBalanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(feeRecipientBalanceAfter - feeRecipientBalanceBefore).to.equal(feeLeftover);
    });

    it("recoverERC20 cannot recover ETH that belongs to feeLeftover", async () => {
      // Setup: Fund vault to have enough balance for fees
      await dashboard.connect(owner).fund({ value: ether("10") });

      // Simulate rewards to trigger fee accrual
      const totalValue = ether("15");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue,
        waitForNextRefSlot: true,
      });

      // Perform voluntary disconnect to collect fees to feeLeftover
      await dashboard.connect(owner).voluntaryDisconnect();

      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.be.gt(0n);

      // Complete the disconnection
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue });

      // Dashboard balance includes feeLeftover
      const dashboardBalance = await ethers.provider.getBalance(dashboard);
      expect(dashboardBalance).to.be.gte(feeLeftover);

      // Add extra ETH to dashboard (not part of feeLeftover)
      const extraETH = ether("1");
      await setBalance(await dashboard.getAddress(), dashboardBalance + extraETH);

      // Try to recover more than available (balance - feeLeftover)
      // Should fail because feeLeftover is protected
      await expect(
        dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, dashboardBalance + extraETH),
      ).to.be.revertedWithCustomError(dashboard, "InsufficientBalance");

      // Can only recover up to (balance - feeLeftover)
      await expect(dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, extraETH))
        .to.emit(dashboard, "AssetsRecovered")
        .withArgs(stranger, ETH_ADDRESS, extraETH);
    });

    it("recoverFeeLeftover reverts with EthTransferFailed when feeRecipient rejects ETH", async () => {
      // Deploy a contract that rejects ETH transfers
      const ethRejector: EthRejector = await ethers.deployContract("EthRejector");

      // Set the fee recipient to the rejector contract
      await dashboard.connect(nodeOperator).setFeeRecipient(ethRejector);
      expect(await dashboard.feeRecipient()).to.equal(await ethRejector.getAddress());

      // Setup: Fund vault to have enough balance for fees
      await dashboard.connect(owner).fund({ value: ether("10") });

      // Simulate rewards to trigger fee accrual
      const totalValue = ether("15");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue,
        waitForNextRefSlot: true,
      });

      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.be.gt(0n);

      // Perform voluntary disconnect to collect fees to feeLeftover
      await dashboard.connect(owner).voluntaryDisconnect();

      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.be.gt(0n);

      // Complete the disconnection
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue });

      // Try to recover fee leftover - should fail because recipient rejects ETH
      await expect(dashboard.recoverFeeLeftover())
        .to.be.revertedWithCustomError(dashboard, "EthTransferFailed")
        .withArgs(ethRejector, feeLeftover);
    });
  });
});
