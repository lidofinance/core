import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { ether, impersonate } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const TOTAL_BASIS_POINTS = 100_00n;

describe.only("Integration: Vault obligations", () => {
  let ctx: ProtocolContext;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let roles: VaultRoles;

  let stakingVaultAddress: string;
  let treasuryAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;
  let validatorExit: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  let originalSnapshot: string;
  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub } = ctx.contracts);

    [owner, nodeOperator, redemptionMaster, validatorExit, stranger, whale] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    stakingVaultAddress = await stakingVault.getAddress();
    treasuryAddress = await ctx.contracts.locator.treasury();

    agentSigner = await ctx.getSigner("agent");

    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), validatorExit);
  });

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  async function addRedemptionsObligation(value: bigint) {
    const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
    await setBalance(stakingVaultAddress, 0); // hack: deposit to beacon chain
    await vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, value);
    await setBalance(stakingVaultAddress, balanceBefore); // restore balance
  }

  context("Lido fees obligations", () => {
    it("Will revert if accrued fees are less than the cumulative fees", async () => {
      const accruedLidoFees = ether("1.1");

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.cumulativeSettledLidoFees).to.equal(0n);

      // Report the vault data with accrued lido fees
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(ether("0.1"));
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(ether("1"));

      // Try to lower the fees
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: accruedLidoFees - 1n }))
        .to.be.revertedWithCustomError(vaultHub, "InvalidFees")
        .withArgs(stakingVaultAddress, accruedLidoFees - 1n, accruedLidoFees);
    });

    it("Updated on the vault report for vault with no balance", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.cumulativeSettledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, accruedLidoFees, 0n, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(0n);
    });

    it("Settled on the vault report for vault with enough balance", async () => {
      const accruedLidoFees = ether("1");

      await dashboard.connect(roles.funder).fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.cumulativeSettledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, 0n, accruedLidoFees, accruedLidoFees) // 0 unsettled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(accruedLidoFees);
    });

    it("Partially settled on the vault report for vault with some balance", async () => {
      // Make sure the vault has enough balance
      const accruedLidoFees = ether("1");
      const vaultBalance = ether("0.7");
      const unsettledLidoFees = accruedLidoFees - vaultBalance;

      await setBalance(stakingVaultAddress, vaultBalance);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.cumulativeSettledLidoFees).to.equal(0n);

      // Report the vault data with accrued lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, unsettledLidoFees, vaultBalance, vaultBalance) // unsettled, settled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, vaultBalance);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(vaultBalance);
    });

    it("Get updated on several consecutive reports", async () => {
      let accruedLidoFees = ether("1");
      const vaultBalance = ether("0.7");
      const unsettledLidoFees = accruedLidoFees - vaultBalance;

      await setBalance(stakingVaultAddress, vaultBalance);

      // 1st report with partial settlement
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, unsettledLidoFees, vaultBalance, vaultBalance)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, vaultBalance);

      // 2nd report with no fees emit nothing because fees are not changed (reported value is cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees })).not.to.emit(
        vaultHub,
        "VaultObligationsUpdated",
      );

      // Increase the fees
      accruedLidoFees += ether("0.5");

      // 3rd report with zero settlement
      const expectedUnsettled = accruedLidoFees - vaultBalance;
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, expectedUnsettled, 0n, vaultBalance);

      // 4th report with full settlement
      const delta = ether("0.1");
      const feesToSettle = expectedUnsettled + delta;
      accruedLidoFees += delta;

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, 0n, feesToSettle, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, feesToSettle);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(feesToSettle + vaultBalance);
    });
  });

  context("Setting redemptions obligations", () => {
    beforeEach(async () => {
      const { lido, locator } = ctx.contracts;

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).submit(ZeroAddress, { value: ether("1000") });
      await lido.connect(whale).transfer(burner, ether("1000"));
      await lido.connect(burner).burnShares(ether("700"));

      await report(ctx, { clDiff: 0n });
      await reportVaultDataWithProof(ctx, stakingVault);
    });

    it("Adds nothing to the vault with no liabilities", async () => {
      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(0n);

      expect((await vaultHub.vaultRecord(stakingVaultAddress)).liabilityShares).to.equal(0n);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, ether("1"))).not.to.emit(
        vaultHub,
        "VaultObligationsUpdated",
      );

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(0n);
    });

    it("Can be applied to the vault with liabilities", async () => {
      const { lido } = ctx.contracts;

      const liabilityShares = 1n;

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      const maxRedemptions = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(0n);

      // Over the max possible withdrawals
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, maxRedemptions + 1n))
        .to.emit(vaultHub, "RedemptionsSet")
        .withArgs(stakingVaultAddress, maxRedemptions);

      // Second time should not emit anything because the obligation is already set
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, maxRedemptions)).not.to.emit(
        vaultHub,
        "RedemptionsSet",
      );

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions);

      // Decrease the obligation
      const newRedemptionsValue = maxRedemptions / 2n; // => 1 wei
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, newRedemptionsValue))
        .to.emit(vaultHub, "RedemptionsSet")
        .withArgs(stakingVaultAddress, newRedemptionsValue);

      const obligationsAfterDecreased = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterDecreased.redemptions).to.equal(newRedemptionsValue);

      // Remove the obligation
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, 0))
        .to.emit(vaultHub, "RedemptionsSet")
        .withArgs(stakingVaultAddress, 0n);

      const obligationsAfterRemoved = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterRemoved.redemptions).to.equal(0n);
    });

    it("Should not settle if the vault has enough balance", async () => {
      const { lido } = ctx.contracts;

      const liabilityShares = ether("1");
      const maxRedemptions = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      await dashboard.connect(roles.funder).fund({ value: ether("2") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(0n);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, maxRedemptions))
        .to.emit(vaultHub, "RedemptionsSet")
        .withArgs(stakingVaultAddress, maxRedemptions)
        .not.to.emit(vaultHub, "VaultObligationsUpdated");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
    });

    it("Should pause beacon chain deposits when unsettled obligations are too high", async () => {
      const { lido } = ctx.contracts;

      const liabilityShares = ether("10");
      const maxRedemptions = await lido.getPooledEthBySharesRoundUp(liabilityShares);

      await dashboard.connect(roles.funder).fund({ value: ether("20") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(0n);

      const vaultBalance = ether("1");
      await setBalance(stakingVaultAddress, vaultBalance);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, maxRedemptions))
        .to.emit(vaultHub, "RedemptionsSet")
        .withArgs(stakingVaultAddress, maxRedemptions)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
    });

    context("Must decrease on liability shares change", () => {
      let liabilityShares: bigint;
      let maxRedemptions: bigint;

      beforeEach(async () => {
        const { lido } = ctx.contracts;

        liabilityShares = ether("1");
        maxRedemptions = await lido.getPooledEthBySharesRoundUp(liabilityShares);

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

        await addRedemptionsObligation(maxRedemptions);
      });

      // TODO: check rounding errors
      it.skip("On shares burned", async () => {
        const { lido } = ctx.contracts;

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        expect(await lido.sharesOf(roles.burner)).to.equal(liabilityShares);
        await lido.connect(roles.burner).approve(dashboard, liabilityShares);

        const sharesToBurn = liabilityShares / 2n;
        const expectedRedemptions = await lido.getPooledEthBySharesRoundUp(sharesToBurn);

        await expect(dashboard.connect(roles.burner).burnShares(sharesToBurn))
          .to.emit(vaultHub, "RedemptionsDecreased")
          .withArgs(stakingVaultAddress, expectedRedemptions, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(expectedRedemptions);
      });

      // TODO: check rounding errors
      it.skip("On vault rebalanced", async () => {
        const { lido } = ctx.contracts;

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        const sharesToBurn = liabilityShares / 2n;
        const expectedRedemptions = await lido.getPooledEthBySharesRoundUp(sharesToBurn);

        await expect(dashboard.connect(roles.rebalancer).rebalanceVault(expectedRedemptions))
          .to.emit(vaultHub, "RedemptionsDecreased")
          .withArgs(stakingVaultAddress, expectedRedemptions, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(expectedRedemptions);
      });

      it("Should not increase on new minting", async () => {
        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner, ether("1"));

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
      });
    });

    context("Must be settled on report", () => {
      let liabilityShares: bigint;
      let maxRedemptions: bigint;

      beforeEach(async () => {
        const { lido } = ctx.contracts;

        liabilityShares = ether("1");
        maxRedemptions = await lido.getPooledEthBySharesRoundUp(liabilityShares);

        await dashboard.connect(roles.funder).fund({ value: ether("1") });
        await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

        await addRedemptionsObligation(maxRedemptions);
      });

      it("Should not change on report when vault has no balance", async () => {
        await setBalance(stakingVaultAddress, 0);

        await expect(reportVaultDataWithProof(ctx, stakingVault)).not.to.emit(vaultHub, "VaultObligationsUpdated");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
      });

      it("Should partially settle on report when vault has some balance", async () => {
        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "VaultObligationsUpdated")
          .withArgs(stakingVaultAddress, maxRedemptions - vaultBalance, vaultBalance, 0n, 0n, 0n)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions - vaultBalance);
      });

      it("Should fully settle on report when vault has enough balance", async () => {
        await setBalance(stakingVaultAddress, ether("100"));

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "VaultObligationsUpdated")
          .withArgs(stakingVaultAddress, 0n, maxRedemptions, 0n, 0n, 0n)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(0n);
      });
    });
  });

  context("Settling on report", () => {
    let liabilityShares: bigint;
    let maxRedemptions: bigint;

    beforeEach(async () => {
      liabilityShares = ether("1");
      maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      await addRedemptionsObligation(maxRedemptions);
    });

    it("Should settle redemptions and Lido fees in correct order", async () => {
      let accruedLidoFees = ether("1");
      const vaultBalance = ether("0.7");

      await setBalance(stakingVaultAddress, vaultBalance);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

      const unsettledRedemptions = maxRedemptions - vaultBalance;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, unsettledRedemptions, vaultBalance, accruedLidoFees, 0n, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(unsettledRedemptions);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(0n);

      // fund to the vault to settle some obligations
      const funded = ether("1");
      const feesIncreased = ether("0.1");
      await dashboard.connect(roles.funder).fund({ value: funded });

      // add some Lido fees
      accruedLidoFees += feesIncreased;

      const expectedSettledLidoFees1 = funded - unsettledRedemptions;
      const expectedUnsettledLidoFees = accruedLidoFees - expectedSettledLidoFees1;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(
          stakingVaultAddress,
          0n,
          unsettledRedemptions,
          expectedUnsettledLidoFees,
          expectedSettledLidoFees1,
          expectedSettledLidoFees1,
        );

      const obligationsAfterFunding = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterFunding.redemptions).to.equal(0n);
      expect(obligationsAfterFunding.unsettledLidoFees).to.equal(expectedUnsettledLidoFees);
      expect(obligationsAfterFunding.cumulativeSettledLidoFees).to.equal(expectedSettledLidoFees1);

      // fund to the vault to settle all the obligations
      await dashboard.connect(roles.funder).fund({ value: funded });

      accruedLidoFees += feesIncreased;

      const expectedSettledLidoFees2 = expectedUnsettledLidoFees + feesIncreased;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, 0n, expectedSettledLidoFees2, accruedLidoFees);

      const obligationsAfterReport = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterReport.redemptions).to.equal(0n);
      expect(obligationsAfterReport.unsettledLidoFees).to.equal(0);
      expect(obligationsAfterReport.cumulativeSettledLidoFees).to.equal(accruedLidoFees);
    });

    it.skip("Should rebase small values properly");
  });

  context("Manual settlement via dashboard", () => {
    let liabilityShares: bigint;
    let maxRedemptions: bigint;
    let accruedLidoFees: bigint;
    let unsettledLidoFees: bigint;
    let cumulativeSettledLidoFees: bigint;

    beforeEach(async () => {
      liabilityShares = ether("1");
      accruedLidoFees = ether("2.1");

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner.address, liabilityShares);

      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      ({ unsettledLidoFees, cumulativeSettledLidoFees } = await vaultHub.vaultObligations(stakingVaultAddress));

      maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(liabilityShares);
      await addRedemptionsObligation(maxRedemptions);
    });

    it("Reverts when vault balance is zero and no funding provided", async () => {
      await setBalance(stakingVaultAddress, 0);

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroBalance",
      );
    });

    it("Partially settles obligations using existing balance", async () => {
      const funding = ether("0.5");

      await dashboard.connect(roles.funder).fund({ value: funding });
      const expectedUnsettledRedemptions = maxRedemptions - funding;
      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(
          stakingVaultAddress,
          expectedUnsettledRedemptions,
          funding,
          unsettledLidoFees,
          0n,
          cumulativeSettledLidoFees,
        );

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(expectedUnsettledRedemptions);
      expect(obligationsAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(cumulativeSettledLidoFees);
    });

    it("Fully settles obligations when funded", async () => {
      const expectedSettledFees = maxRedemptions + unsettledLidoFees;
      const extraFunding = expectedSettledFees + ether("1"); // 1 ether extra should stay in the vault

      await dashboard.connect(roles.funder).fund({ value: extraFunding });

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, maxRedemptions, 0n, unsettledLidoFees, accruedLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(0n);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(accruedLidoFees);

      const vaultBalanceAfter = await ethers.provider.getBalance(stakingVaultAddress);
      expect(vaultBalanceAfter).to.equal(ether("1"));
    });
  });

  context("Minting with unsettled Lido fees", () => {
    const accruedLidoFees = ether("0.1");

    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
      await setBalance(stakingVaultAddress, 0);
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      await setBalance(stakingVaultAddress, balanceBefore);
    });

    it("Should revert when trying to mint more than total value minus unsettled Lido fees", async () => {
      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVaultAddress)).reserveRatioBP;
      const maxMintableRatioBP = TOTAL_BASIS_POINTS - reserveRatioBP;
      const maxLocked = totalValue - accruedLidoFees;
      const maxMintableEther = (maxLocked * maxMintableRatioBP) / TOTAL_BASIS_POINTS;

      await expect(
        dashboard.connect(roles.minter).mintShares(roles.burner, maxMintableEther + 1n),
      ).to.be.revertedWithCustomError(dashboard, "MintingCapacityExceeded");

      await expect(dashboard.connect(roles.minter).mintShares(roles.burner, maxMintableEther))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVaultAddress, maxMintableEther, maxLocked);
    });

    it("Should not take withdrals obligation into account", async () => {
      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVaultAddress)).reserveRatioBP;
      const maxMintableRatioBP = TOTAL_BASIS_POINTS - reserveRatioBP;
      const maxLocked = totalValue - accruedLidoFees;
      const maxMintableEther = (maxLocked * maxMintableRatioBP) / TOTAL_BASIS_POINTS;

      const mintEth = maxMintableEther / 2n;
      const mintShares = await ctx.contracts.lido.getPooledEthBySharesRoundUp(mintEth);

      // Add 1/2 of the mintable ether to the vault as withdrawals obligation, so if withdrawals obligation is taken into account,
      // the user will not be able to mint anything from this moment
      await dashboard.connect(roles.minter).mintShares(roles.burner, mintShares);

      await addRedemptionsObligation(mintEth);

      await expect(dashboard.connect(roles.minter).mintShares(roles.burner, mintShares))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVaultAddress, mintShares, maxLocked);
    });
  });

  context("Withdrawal takes unsettled obligations into account", () => {
    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, ether("1"));
      await addRedemptionsObligation(ether("1"));
    });

    it("Should work when trying to withdraw less than available balance", async () => {
      let withdrawableEther = await vaultHub.withdrawableEther(stakingVaultAddress);
      expect(withdrawableEther).to.equal(0n);

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      withdrawableEther = await vaultHub.withdrawableEther(stakingVaultAddress);
      expect(withdrawableEther).to.equal(ether("0.75")); // 0.25 ether is reserve ratio

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableEther))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawableEther);
    });

    it("Should revert when trying to withdraw more than available balance", async () => {
      // simulate deposit to Beacon chain -1 ether
      await setBalance(stakingVaultAddress, ether("1"));
      const unlockedValue = await vaultHub.unlocked(stakingVaultAddress);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, unlockedValue))
        .to.be.revertedWithCustomError(dashboard, "WithdrawalExceedsWithdrawable")
        .withArgs(unlockedValue, 0n);
    });

    // TODO: add test for node operator fees
  });

  context("Disconnect flow", () => {
    beforeEach(async () => {});

    it("Should revert when trying to disconnect with unsettled obligations", async () => {
      // 1 ether of the connection deposit will be settled to the treasury, so 0.1 ether will be left in obligations
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });

      const obligations = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligations.unsettledLidoFees).to.equal(ether("0.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);

      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "VaultHasUnsettledObligations")
        .withArgs(stakingVaultAddress, ether("0.1"), 0);
    });

    it("Should allow to disconnect when all obligations are settled", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });

      // add some more ether to the vault to cover all the fees before disconnecting
      await dashboard.connect(roles.funder).fund({ value: ether("0.1") });

      await expect(dashboard.connect(roles.disconnecter).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);
    });

    it("Should not allow to disconnect when there is not enough balance to cover the exit fees", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      await dashboard.connect(roles.disconnecter).voluntaryDisconnect();

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") }))
        .to.be.revertedWithCustomError(vaultHub, "VaultHasUnsettledObligations")
        .withArgs(stakingVaultAddress, ether("0.1"), 0);
    });

    it("Should take last fees from the post disconnect report", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      // successfully disconnect
      await dashboard.connect(roles.disconnecter).voluntaryDisconnect();

      // adding 1 ether to cover the exit fees
      await owner.sendTransaction({ to: stakingVaultAddress, value: ether("1") });

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, 0n, ether("0.1"), ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      // 0.9 ether should be left in the vault
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.9"));
    });
  });

  context("Deposit pause", () => {
    it("Should pause deposits when unsettled fees are >= 1 ether", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, accruedLidoFees, 0n, 0n)
        .to.emit(stakingVault, "BeaconChainDepositsPaused"); // paused because >= 1 ether of unsettled fees

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(0n);
    });

    it("Should resume deposits when unsettled fees are < 1 ether", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      expect(await stakingVault.beaconChainDepositsPaused()).to.equal(true);

      await dashboard.connect(roles.funder).fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsBefore.cumulativeSettledLidoFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsUpdated")
        .withArgs(stakingVaultAddress, 0n, 0n, 0n, accruedLidoFees, accruedLidoFees) // 0 unsettled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.cumulativeSettledLidoFees).to.equal(accruedLidoFees);
    });
  });
});
