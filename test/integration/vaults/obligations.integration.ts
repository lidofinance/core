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

describe("Integration: Vault obligations", () => {
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

    await reportVaultDataWithProof(ctx, stakingVault);
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
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued lido fees
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);

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
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);
    });

    it("Settled on the vault report for vault with enough balance", async () => {
      const accruedLidoFees = ether("1");

      await dashboard.connect(roles.funder).fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued Lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, accruedLidoFees, 0n, 0n, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(accruedLidoFees);
    });

    it("Partially settled on the vault report for vault with some balance", async () => {
      // Make sure the vault has enough balance
      const accruedLidoFees = ether("1");
      const funding = ether("0.5");

      await dashboard.connect(roles.funder).fund({ value: funding });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      const unsettledLidoFees = accruedLidoFees - funding;
      // Report the vault data with accrued lido fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, funding, 0n, unsettledLidoFees, funding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, funding);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(funding);
    });

    it("Get updated on several consecutive reports", async () => {
      let accruedLidoFees = ether("1");
      const funding = ether("0.5");
      const unsettledLidoFees = accruedLidoFees - funding;

      await dashboard.connect(roles.funder).fund({ value: funding });

      // 1st report with partial settlement
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, funding, 0n, unsettledLidoFees, funding)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, funding);

      // 2nd report with no fees emit nothing because fees are not changed (reported value is cumulative)
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees })).not.to.emit(
        vaultHub,
        "VaultObligationsSettled",
      );

      // Increase the fees
      accruedLidoFees += ether("0.5");

      // 3rd report with zero settlement
      const expectedUnsettled = accruedLidoFees - funding;
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, expectedUnsettled, funding);

      // 4th report with full settlement
      const delta = ether("0.1");
      const feesToSettle = expectedUnsettled + delta;
      accruedLidoFees += delta;

      await dashboard.connect(roles.funder).fund({ value: feesToSettle });

      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, feesToSettle, funding)
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, feesToSettle, 0n, 0n, accruedLidoFees)
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, feesToSettle);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(feesToSettle + funding);
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
        "VaultObligationsSettled",
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
        .to.emit(vaultHub, "RedemptionsUpdated")
        .withArgs(stakingVaultAddress, maxRedemptions);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(maxRedemptions);

      // Decrease the obligation
      const newRedemptionsValue = maxRedemptions / 2n; // => 1 wei
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, newRedemptionsValue))
        .to.emit(vaultHub, "RedemptionsUpdated")
        .withArgs(stakingVaultAddress, newRedemptionsValue);

      const obligationsAfterDecreased = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterDecreased.redemptions).to.equal(newRedemptionsValue);

      // Remove the obligation
      await expect(vaultHub.connect(agentSigner).setVaultRedemptions(stakingVaultAddress, 0))
        .to.emit(vaultHub, "RedemptionsUpdated")
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
        .to.emit(vaultHub, "RedemptionsUpdated")
        .withArgs(stakingVaultAddress, maxRedemptions)
        .not.to.emit(vaultHub, "VaultObligationsSettled");

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
        .to.emit(vaultHub, "RedemptionsUpdated")
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

      it("On shares burned", async () => {
        const { lido } = ctx.contracts;

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        expect(await lido.sharesOf(roles.burner)).to.equal(liabilityShares);
        await lido.connect(roles.burner).approve(dashboard, liabilityShares);

        const sharesToBurn = liabilityShares / 2n;
        const expectedRedemptions = await lido.getPooledEthBySharesRoundUp(sharesToBurn);

        await expect(dashboard.connect(roles.burner).burnShares(sharesToBurn))
          .to.emit(vaultHub, "RedemptionsUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(expectedRedemptions);
      });

      it("On vault rebalanced", async () => {
        const { lido } = ctx.contracts;

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        const rebalanceAmount = (await lido.getPooledEthBySharesRoundUp(liabilityShares)) / 2n;
        const expectedRedemptions = maxRedemptions - rebalanceAmount;
        await expect(dashboard.connect(roles.rebalancer).rebalanceVault(rebalanceAmount))
          .to.emit(vaultHub, "RedemptionsUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(expectedRedemptions);
      });

      it("Should not increase on new minting", async () => {
        await dashboard.connect(roles.funder).fund({ value: ether("2") });
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

        await expect(reportVaultDataWithProof(ctx, stakingVault)).not.to.emit(vaultHub, "VaultObligationsSettled");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions);
      });

      it("Should partially settle on report when vault has some balance", async () => {
        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "VaultObligationsSettled")
          .withArgs(stakingVaultAddress, vaultBalance, 0n, maxRedemptions - vaultBalance, 0n, 0n)
          .not.to.emit(vaultHub, "VaultRebalanced");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptions).to.equal(maxRedemptions - vaultBalance);
      });

      it("Should fully settle on report when vault has enough balance", async () => {
        await setBalance(stakingVaultAddress, ether("100"));

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "VaultObligationsSettled")
          .withArgs(stakingVaultAddress, maxRedemptions, 0n, 0n, 0n, 0n)
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
    });

    it("Should settle redemptions and Lido fees in correct order", async () => {
      let accruedLidoFees = ether("1");
      const vaultBalance = ether("0.7");

      await addRedemptionsObligation(maxRedemptions);
      await setBalance(stakingVaultAddress, vaultBalance);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptions).to.equal(maxRedemptions);

      const unsettledRedemptions = maxRedemptions - vaultBalance;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, vaultBalance, 0n, unsettledRedemptions, accruedLidoFees, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(unsettledRedemptions);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);

      // fund to the vault to settle some obligations
      const funded = ether("1");
      const feesIncreased = ether("0.1");
      await dashboard.connect(roles.funder).fund({ value: funded });

      // add some Lido fees
      accruedLidoFees += feesIncreased;

      const expectedSettledLidoFees1 = funded - unsettledRedemptions;
      const expectedUnsettledLidoFees = accruedLidoFees - expectedSettledLidoFees1;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(
          stakingVaultAddress,
          unsettledRedemptions,
          expectedSettledLidoFees1,
          0n,
          expectedUnsettledLidoFees,
          expectedSettledLidoFees1,
        );

      const obligationsAfterFunding = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterFunding.redemptions).to.equal(0n);
      expect(obligationsAfterFunding.unsettledLidoFees).to.equal(expectedUnsettledLidoFees);
      expect(obligationsAfterFunding.settledLidoFees).to.equal(expectedSettledLidoFees1);

      // fund to the vault to settle all the obligations
      await dashboard.connect(roles.funder).fund({ value: funded });

      accruedLidoFees += feesIncreased;

      const expectedSettledLidoFees2 = expectedUnsettledLidoFees + feesIncreased;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, expectedSettledLidoFees2, 0n, 0n, accruedLidoFees);

      const obligationsAfterReport = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterReport.redemptions).to.equal(0n);
      expect(obligationsAfterReport.unsettledLidoFees).to.equal(0);
      expect(obligationsAfterReport.settledLidoFees).to.equal(accruedLidoFees);
    });

    it("Should correctly calculate settlement values", async () => {
      const accruedLidoFees = ether("1");
      const vaultBalance = ether("0.7");

      await addRedemptionsObligation(maxRedemptions);
      await setBalance(stakingVaultAddress, vaultBalance);

      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("2"));
      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultBalance, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, vaultBalance, 0n, maxRedemptions - vaultBalance, accruedLidoFees, 0n);
    });

    it("Should not make the vault unhealthy", async () => {
      const { lido } = ctx.contracts;
      const accruedLidoFees = ether("1");
      const vaultBalance = ether("1.5");
      const totalValue = ether("2");

      await setBalance(stakingVaultAddress, vaultBalance);

      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVaultAddress)).reserveRatioBP;
      const lockedEther =
        ((await lido.getPooledEthBySharesRoundUp(liabilityShares)) * TOTAL_BASIS_POINTS) /
        (TOTAL_BASIS_POINTS - reserveRatioBP);

      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(totalValue);
      expect(await vaultHub.locked(stakingVaultAddress)).to.equal(lockedEther);

      let testTotalValue = lockedEther + ether("0.5"); // this is a diff from which fees can be settled
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: testTotalValue, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.5"), 0n, ether("0.5"), ether("0.5"));

      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;

      // should not emit anything because the vault is barely healthy
      testTotalValue = lockedEther;
      await expect(
        reportVaultDataWithProof(ctx, stakingVault, { totalValue: testTotalValue, accruedLidoFees }),
      ).not.to.emit(vaultHub, "VaultObligationsSettled");

      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;

      // should not emit anything because the vault is unhealthy
      testTotalValue = lockedEther - ether("0.5");
      await expect(
        reportVaultDataWithProof(ctx, stakingVault, { totalValue: testTotalValue, accruedLidoFees }),
      ).not.to.emit(vaultHub, "VaultObligationsSettled");

      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.false;

      // should emit because the vault is healthy again
      testTotalValue = lockedEther + ether("0.5");
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: testTotalValue, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.5"), 0n, 0n, accruedLidoFees);

      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;
    });
  });

  context("Manual settlement via dashboard", () => {
    let liabilityShares: bigint;
    let maxRedemptions: bigint;
    let accruedLidoFees: bigint;
    let unsettledLidoFees: bigint;
    let settledLidoFees: bigint;

    beforeEach(async () => {
      liabilityShares = ether("1");
      accruedLidoFees = ether("2.1");

      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, liabilityShares);

      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      ({ unsettledLidoFees, settledLidoFees } = await vaultHub.vaultObligations(stakingVaultAddress));

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
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVaultAddress)).reserveRatioBP;
      const lockedEther = (maxRedemptions * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - reserveRatioBP);
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(lockedEther);

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, maxRedemptions, 0n, 0n, unsettledLidoFees, settledLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(0n);
      expect(obligationsAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(settledLidoFees);
    });

    it("Fully settles obligations when funded", async () => {
      // Fund to cover all obligations
      const funding = accruedLidoFees + maxRedemptions;
      await dashboard.connect(roles.funder).fund({ value: funding });

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, maxRedemptions, unsettledLidoFees, 0n, 0n, accruedLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptions).to.equal(0n);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(accruedLidoFees);
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
      const mintableShares = await dashboard.totalMintingCapacityShares();
      const maxLockableValue = await vaultHub.maxLockableValue(stakingVaultAddress);

      await expect(
        dashboard.connect(roles.minter).mintShares(roles.burner, mintableShares + 1n),
      ).to.be.revertedWithCustomError(dashboard, "MintingCapacityExceeded");

      await expect(dashboard.connect(roles.minter).mintShares(roles.burner, mintableShares))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVaultAddress, mintableShares, maxLockableValue);
    });

    it("Should not take withdrals obligation into account", async () => {
      const mintableShares = await dashboard.totalMintingCapacityShares();
      // const maxLocked = await vaultHub.maxLockableValue(stakingVaultAddress);

      const sharesToMint = mintableShares / 2n;

      // Add 1/2 of the mintable ether to the vault as withdrawals obligation, so if withdrawals obligation is taken into account,
      // the user will not be able to mint anything from this moment
      await dashboard.connect(roles.minter).mintShares(roles.burner, sharesToMint);

      const maxRedemptions = await ctx.contracts.lido.getPooledEthBySharesRoundUp(sharesToMint);
      await addRedemptionsObligation(maxRedemptions);

      await expect(dashboard.connect(roles.minter).mintShares(roles.burner, sharesToMint)).to.emit(
        vaultHub,
        "MintedSharesOnVault",
      );
      // .withArgs(stakingVaultAddress, sharesToMint, maxLocked); // TODO: check rounding issue
    });
  });

  context("Withdrawal takes unsettled obligations into account", () => {
    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintShares(roles.burner, ether("1"));
      await addRedemptionsObligation(ether("1"));
    });

    it("Should work when trying to withdraw less than available balance", async () => {
      let withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableValue))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawableValue);

      withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);
    });

    it("Should revert when trying to withdraw more than available balance", async () => {
      // simulate deposit to Beacon chain -1 ether
      const withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawableValue + 1n))
        .to.be.revertedWithCustomError(dashboard, "WithdrawalExceedsWithdrawable")
        .withArgs(withdrawableValue + 1n, withdrawableValue);
    });

    // TODO: add test for node operator fees
  });

  context("Disconnect flow", () => {
    beforeEach(async () => {});

    it("Should revert when trying to disconnect with unsettled obligations", async () => {
      // 1 ether of the connection deposit will be settled to the treasury, so 0.1 ether will be left in obligations
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });

      const obligations = await vaultHub.vaultObligations(stakingVaultAddress);

      // will not be settled because of the connection deposit
      expect(obligations.unsettledLidoFees).to.equal(ether("1.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1"));

      // will revert because of the unsettled obligations event trying to settle using the connection deposit
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
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.1"), 0n, 0n, ether("1.1"))
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
        .to.emit(vaultHub, "LidoFeesUpdated")
        .withArgs(stakingVaultAddress, accruedLidoFees, 0n)
        .to.emit(stakingVault, "BeaconChainDepositsPaused"); // paused because >= 1 ether of unsettled fees

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);
    });

    it("Should resume deposits when unsettled fees are < 1 ether", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      expect(await stakingVault.beaconChainDepositsPaused()).to.equal(true);

      await dashboard.connect(roles.funder).fund({ value: ether("2") });

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued treasury fees
      await expect(await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, accruedLidoFees, 0n, 0n, accruedLidoFees) // 0 unsettled
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(treasuryAddress, accruedLidoFees)
        .to.emit(stakingVault, "BeaconChainDepositsResumed");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(accruedLidoFees);
    });
  });
});
