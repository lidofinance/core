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
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: Vault obligations", () => {
  let ctx: ProtocolContext;
  let originalSnapshot: string;
  let snapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let stakingVaultAddress: string;
  let treasuryAddress: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;
  let validatorExit: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub } = ctx.contracts);

    [owner, nodeOperator, redemptionMaster, validatorExit, stranger, whale] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
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

  context("Lido fees obligations", () => {
    it("Reverts if accrued fees are less than the cumulative fees", async () => {
      const accruedLidoFees = ether("1.1");

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.unsettledLidoFees).to.equal(0n);
      expect(obligationsBefore.settledLidoFees).to.equal(0n);

      // Report the vault data with accrued lido fees
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);

      // Try to lower the fees in the report
      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: accruedLidoFees - 1n }))
        .to.be.revertedWithCustomError(vaultHub, "InvalidFees")
        .withArgs(stakingVaultAddress, accruedLidoFees - 1n, accruedLidoFees);
    });

    it("Updates on the vault report for vault with no balance", async () => {
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

    it("Setstles on the vault report for vault with enough balance", async () => {
      const accruedLidoFees = ether("1");

      await dashboard.fund({ value: ether("2") });

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

    it("Settles partially on the vault report for vault with some balance", async () => {
      // Make sure the vault has enough balance
      const accruedLidoFees = ether("1");
      const funding = ether("0.5");

      await dashboard.fund({ value: funding });

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

    it("Updates on several consecutive reports", async () => {
      let accruedLidoFees = ether("1");
      const funding = ether("0.5");
      const unsettledLidoFees = accruedLidoFees - funding;

      await dashboard.fund({ value: funding });

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

      await dashboard.fund({ value: feesToSettle });

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

  context("Redemption shares obligations setting", () => {
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

    it("Reverts if the vault has no liabilities", async () => {
      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptionShares).to.equal(0n);

      expect((await vaultHub.vaultRecord(stakingVaultAddress)).liabilityShares).to.equal(0n);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, ether("1")))
        .to.be.revertedWithCustomError(vaultHub, "RedemptionSharesNotSet")
        .withArgs(stakingVaultAddress, ether("1"), 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(0n);
    });

    it("Applies to the vault with liabilities", async () => {
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintShares(stranger, 2n);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptionShares).to.equal(0n);

      // Over the max possible withdrawals (3 shares => 2 shares because of the liabilities)
      await expect(vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, 3n))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 2n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(2n);

      // Decrease the obligation
      await expect(vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, 1n))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 1n);

      const obligationsAfterDecreased = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterDecreased.redemptionShares).to.equal(1n);

      // Remove the obligation
      await expect(vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, 0))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, 0n);

      const obligationsAfterRemoved = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterRemoved.redemptionShares).to.equal(0n);
    });

    it("Does not settle immediately", async () => {
      const redemptionShares = ether("1");

      await dashboard.fund({ value: ether("2") });
      await dashboard.mintShares(stranger, redemptionShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptionShares).to.equal(0n);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, redemptionShares)
        .not.to.emit(vaultHub, "VaultObligationsSettled");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(redemptionShares);
    });

    it("Pauses beacon chain deposits when unsettled obligations are too high", async () => {
      const redemptionShares = ether("10");

      await dashboard.fund({ value: ether("20") });
      await dashboard.mintShares(stranger, redemptionShares);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptionShares).to.equal(0n);

      const vaultBalance = ether("1");
      await setBalance(stakingVaultAddress, vaultBalance);

      await expect(vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares))
        .to.emit(vaultHub, "RedemptionSharesUpdated")
        .withArgs(stakingVaultAddress, redemptionShares)
        .to.emit(stakingVault, "BeaconChainDepositsPaused");

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(redemptionShares);
    });

    context("Decreases on liability shares change", () => {
      let redemptionShares: bigint;

      beforeEach(async () => {
        redemptionShares = ether("1");

        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(owner, redemptionShares);

        await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
      });

      it("On shares burned", async () => {
        const { lido } = ctx.contracts;

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptionShares).to.equal(redemptionShares);

        expect(await lido.sharesOf(owner)).to.equal(redemptionShares);
        await lido.connect(owner).approve(dashboard, redemptionShares);

        const parts = 2n;
        const sharesToBurn = redemptionShares / parts;
        const expectedRedemptions = redemptionShares / parts;

        await expect(dashboard.burnShares(sharesToBurn))
          .to.emit(vaultHub, "RedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, expectedRedemptions);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptionShares).to.equal(expectedRedemptions);
      });

      it("On vault rebalanced", async () => {
        const { lido } = ctx.contracts;
        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptionShares).to.equal(redemptionShares);

        const rebalanceShares = redemptionShares / 2n;
        await expect(dashboard.rebalanceVaultWithShares(rebalanceShares))
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, rebalanceShares, await lido.getPooledEthBySharesRoundUp(rebalanceShares))
          .to.emit(vaultHub, "RedemptionSharesUpdated")
          .withArgs(stakingVaultAddress, rebalanceShares);

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptionShares).to.equal(rebalanceShares);
      });

      it("Does not increase on new minting", async () => {
        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(stranger, ether("1"));

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptionShares).to.equal(redemptionShares);
      });
    });

    context("Settles on report", () => {
      let redemptionShares: bigint;

      beforeEach(async () => {
        redemptionShares = ether("1");

        await dashboard.fund({ value: ether("2") });
        await dashboard.mintShares(stranger, redemptionShares);

        await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
      });

      it("Does not change on report when vault has no balance", async () => {
        await setBalance(stakingVaultAddress, 0);

        await expect(reportVaultDataWithProof(ctx, stakingVault)).not.to.emit(vaultHub, "VaultObligationsSettled");

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptionShares).to.equal(redemptionShares);
      });

      it("Partially settles on report when vault has some balance", async () => {
        const { lido } = ctx.contracts;

        const vaultBalance = ether("0.7");
        await setBalance(stakingVaultAddress, vaultBalance);

        const sharesToRebalance = await lido.getSharesByPooledEth(vaultBalance);
        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptionShares).to.equal(redemptionShares);

        const unsettledRedemptionShares = redemptionShares - sharesToRebalance;
        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "VaultObligationsSettled")
          .withArgs(stakingVaultAddress, sharesToRebalance, 0n, unsettledRedemptionShares, 0n, 0n)
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, sharesToRebalance, await lido.getPooledEthBySharesRoundUp(sharesToRebalance));

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptionShares).to.equal(unsettledRedemptionShares);
      });

      it("Fully settles on report when vault has enough balance", async () => {
        const { lido } = ctx.contracts;

        await setBalance(stakingVaultAddress, ether("100"));

        const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsBefore.redemptionShares).to.equal(redemptionShares);

        await expect(reportVaultDataWithProof(ctx, stakingVault))
          .to.emit(vaultHub, "VaultObligationsSettled")
          .withArgs(stakingVaultAddress, redemptionShares, 0n, 0n, 0n, 0n)
          .to.emit(vaultHub, "VaultRebalanced")
          .withArgs(stakingVaultAddress, redemptionShares, await lido.getPooledEthBySharesRoundUp(redemptionShares));

        const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
        expect(obligationsAfter.redemptionShares).to.equal(0n);
      });
    });
  });

  context("Obligations settlement", () => {
    let redemptionShares: bigint;

    beforeEach(async () => {
      redemptionShares = ether("1");

      await dashboard.fund({ value: ether("1") });
      await dashboard.mintShares(stranger, redemptionShares);
    });

    it("Calculates settlement values correctly", async () => {
      const { lido } = ctx.contracts;

      const accruedLidoFees = ether("1");
      const vaultBalance = ether("0.7");

      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
      await setBalance(stakingVaultAddress, vaultBalance);

      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("2"));
      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;

      const sharesToRebalance = await lido.getSharesByPooledEth(vaultBalance);
      const unsettledRedemptionShares = redemptionShares - sharesToRebalance;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultBalance, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, sharesToRebalance, 0n, unsettledRedemptionShares, accruedLidoFees, 0n);

      const obligationsAfterReport = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterReport.redemptionShares).to.equal(unsettledRedemptionShares);
      expect(obligationsAfterReport.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfterReport.settledLidoFees).to.equal(0n);
    });

    it("Settles obligations in correct order", async () => {
      const { lido } = ctx.contracts;

      const clBalance = ether("100"); // simulate most of the vault balance on CL
      const vaultBalance = ether("0.7");

      let accruedLidoFees = ether("1");
      let totalValue = clBalance + vaultBalance;

      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
      await setBalance(stakingVaultAddress, vaultBalance);

      const obligationsBefore = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsBefore.redemptionShares).to.equal(redemptionShares);

      const sharesToRebalance = await lido.getSharesByPooledEth(vaultBalance);
      const unsettledRedemptionShares = redemptionShares - sharesToRebalance;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, sharesToRebalance, 0n, unsettledRedemptionShares, accruedLidoFees, 0n);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(unsettledRedemptionShares);
      expect(obligationsAfter.unsettledLidoFees).to.equal(accruedLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(0n);
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);

      // fund to the vault to settle some obligations
      const funded = ether("1");
      const feesIncreased = ether("0.1");
      await dashboard.fund({ value: funded });
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(funded);

      // add some Lido fees
      accruedLidoFees += feesIncreased;

      const expectedSettledRedemptionShares = await lido.getPooledEthBySharesRoundUp(unsettledRedemptionShares);
      const expectedSettledLidoFees = funded - expectedSettledRedemptionShares;
      const expectedUnsettledLidoFees = accruedLidoFees - expectedSettledLidoFees;

      totalValue = clBalance + funded;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(
          stakingVaultAddress,
          expectedSettledRedemptionShares,
          expectedSettledLidoFees,
          0n /* redemptionShares */,
          expectedUnsettledLidoFees,
          expectedSettledLidoFees,
        );

      const obligationsAfterFunding = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterFunding.redemptionShares).to.equal(0n);
      expect(obligationsAfterFunding.unsettledLidoFees).to.equal(expectedUnsettledLidoFees);
      expect(obligationsAfterFunding.settledLidoFees).to.equal(expectedSettledLidoFees);

      // fund to the vault to settle all the obligations
      await dashboard.fund({ value: funded });

      accruedLidoFees += feesIncreased;

      await expect(reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, accruedLidoFees - expectedSettledLidoFees, 0n, 0n, accruedLidoFees);

      const obligationsAfterReport = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfterReport.redemptionShares).to.equal(0n);
      expect(obligationsAfterReport.unsettledLidoFees).to.equal(0);
      expect(obligationsAfterReport.settledLidoFees).to.equal(accruedLidoFees);

      expect(await vaultHub.liabilityShares(stakingVaultAddress)).to.equal(0n);
    });

    it("Does not make the vault unhealthy", async () => {
      const accruedLidoFees = ether("1");
      const vaultBalance = ether("1.5");

      await dashboard.fund({ value: vaultBalance });
      await dashboard.mintShares(stranger, await dashboard.remainingMintingCapacityShares(0));

      const feesToSettle = 100n;
      await dashboard.fund({ value: feesToSettle }); // add some ether to make sure some fees are settled

      const expectedUnsettledLidoFees = accruedLidoFees - feesToSettle;
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: vaultBalance, accruedLidoFees }))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, feesToSettle, 0n, expectedUnsettledLidoFees, feesToSettle);

      expect(await vaultHub.isVaultHealthy(stakingVaultAddress)).to.be.true;
    });
  });

  context("Permissionless settlement", () => {
    let redemptionShares: bigint;
    let accruedLidoFees: bigint;
    let unsettledLidoFees: bigint;
    let settledLidoFees: bigint;

    beforeEach(async () => {
      redemptionShares = ether("1");
      accruedLidoFees = ether("2.1");

      await dashboard.fund({ value: ether("2") });
      await dashboard.mintShares(stranger, redemptionShares);

      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      ({ unsettledLidoFees, settledLidoFees } = await vaultHub.vaultObligations(stakingVaultAddress));

      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
    });

    it("Reverts when vault balance is zero and no funding provided", async () => {
      await setBalance(stakingVaultAddress, 0);

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroBalance",
      );
    });

    it("Partially settles obligations with existing balance", async () => {
      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, redemptionShares, 0n, 0n, unsettledLidoFees, settledLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(0n);
      expect(obligationsAfter.unsettledLidoFees).to.equal(unsettledLidoFees);
      expect(obligationsAfter.settledLidoFees).to.equal(settledLidoFees);
    });

    it("Fully settles obligations", async () => {
      const { lido } = ctx.contracts;

      // Fund to cover all obligations
      const ethToRebalance = await lido.getPooledEthBySharesRoundUp(redemptionShares);
      const funding = accruedLidoFees + ethToRebalance;
      await dashboard.fund({ value: funding });

      await expect(vaultHub.settleVaultObligations(stakingVaultAddress))
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, ethToRebalance, unsettledLidoFees, 0n, 0n, accruedLidoFees);

      const obligationsAfter = await vaultHub.vaultObligations(stakingVaultAddress);
      expect(obligationsAfter.redemptionShares).to.equal(0n);
      expect(obligationsAfter.unsettledLidoFees).to.equal(0n);
      expect(obligationsAfter.settledLidoFees).to.equal(accruedLidoFees);
    });
  });

  context("Minting", () => {
    const accruedLidoFees = ether("0.1");

    beforeEach(async () => {
      await dashboard.fund({ value: ether("1") });

      const balanceBefore = await ethers.provider.getBalance(stakingVaultAddress);
      await setBalance(stakingVaultAddress, 0);
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      await setBalance(stakingVaultAddress, balanceBefore);
    });

    it("Reverts when trying to mint more than total value minus unsettled Lido fees", async () => {
      const mintableShares = await dashboard.totalMintingCapacityShares();

      await expect(dashboard.mintShares(stranger, mintableShares + 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );

      await expect(dashboard.mintShares(stranger, mintableShares)).to.emit(vaultHub, "MintedSharesOnVault");

      expect(await vaultHub.liabilityShares(stakingVaultAddress)).to.equal(mintableShares);
    });

    it("Does not take redemptions obligation into account", async () => {
      const mintableShares = await dashboard.totalMintingCapacityShares();
      const sharesToMint = mintableShares / 2n;

      // Add 1/2 of the mintable ether to the vault as withdrawals obligation, so if withdrawals obligation is taken into account,
      // the user will not be able to mint anything from this moment
      await dashboard.mintShares(stranger, sharesToMint);
      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, sharesToMint);

      await await expect(dashboard.mintShares(stranger, sharesToMint)).to.emit(vaultHub, "MintedSharesOnVault");
    });
  });

  context("Withdrawals", () => {
    let redemptionShares: bigint;

    beforeEach(async () => {
      redemptionShares = ether("1");

      await dashboard.fund({ value: ether("1") });
      await dashboard.mintShares(stranger, redemptionShares);

      await vaultHub.connect(agentSigner).setVaultRedemptionShares(stakingVaultAddress, redemptionShares);
    });

    it("Reverts when trying to withdraw more than available balance", async () => {
      // simulate deposit to Beacon chain -1 ether
      const withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      await expect(dashboard.withdraw(stranger, withdrawableValue + 1n))
        .to.be.revertedWithCustomError(dashboard, "ExceedsWithdrawable")
        .withArgs(withdrawableValue + 1n, withdrawableValue);
    });

    it("Works when trying to withdraw less than withdrawable balance", async () => {
      await dashboard.fund({ value: ether("1") }); // 1 ether to cover the redemptions

      let withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);

      const withdrawable = ether("1");
      await dashboard.fund({ value: withdrawable });
      expect(await vaultHub.withdrawableValue(stakingVaultAddress)).to.equal(withdrawable);

      await expect(dashboard.withdraw(stranger, withdrawable))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawable);

      withdrawableValue = await vaultHub.withdrawableValue(stakingVaultAddress);
      expect(withdrawableValue).to.equal(0n);
    });
  });

  // TODO: Need to fix the disconnect flow first
  context.skip("Disconnect flow", () => {
    it("Reverts when trying to disconnect with unsettled obligations", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });

      const obligations = await vaultHub.vaultObligations(stakingVaultAddress);

      // 1 ether of the connection deposit will be settled to the treasury
      expect(obligations.unsettledLidoFees).to.equal(ether("1.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1"));

      // will revert because of the unsettled obligations event trying to settle using the connection deposit
      await expect(dashboard.voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "UnsettledObligationsExceedsAllowance")
        .withArgs(stakingVaultAddress, ether("1"), 0);

      expect(obligations.unsettledLidoFees).to.equal(ether("1.1"));
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("1"));
    });

    it("Allows to disconnect when all obligations are settled", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });
      await dashboard.fund({ value: ether("0.1") });

      await expect(dashboard.voluntaryDisconnect())
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("1.1"), 0n, 0n, ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);
    });

    it("Allows to fund after disconnect initiated", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1.1") });
      await dashboard.fund({ value: ether("0.1") }); // cover all the fees

      await expect(dashboard.voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVaultAddress);

      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(0n);
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(0n);

      await dashboard.fund({ value: ether("0.1") });

      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.1"));
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("0.1"));
    });

    it("Reverts disconnect process when balance is not enough to cover the exit fees", async () => {
      expect(await vaultHub.totalValue(stakingVaultAddress)).to.equal(ether("1"));
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      const totalValue = await vaultHub.totalValue(stakingVaultAddress);
      await dashboard.voluntaryDisconnect();

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue, accruedLidoFees: ether("1.1") }))
        .to.be.revertedWithCustomError(vaultHub, "UnsettledObligationsExceedsAllowance")
        .withArgs(stakingVaultAddress, ether("0.1"), 0);
    });

    it("Should take last fees from the post disconnect report with direct transfer", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      const totalValueOnRefSlot = await vaultHub.totalValue(stakingVaultAddress);

      // successfully disconnect
      await dashboard.voluntaryDisconnect();

      // adding 1 ether to cover the exit fees
      await owner.sendTransaction({ to: stakingVaultAddress, value: ether("1") });

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValueOnRefSlot,
          accruedLidoFees: ether("1.1"),
        }),
      )
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.1"), 0n, 0n, ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      // 0.9 ether should be left in the vault
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.9"));
    });

    it("Should take last fees from the post disconnect report with fund", async () => {
      // 1 ether of the connection deposit will be settled to the treasury
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees: ether("1") });

      const totalValueOnRefSlot = await vaultHub.totalValue(stakingVaultAddress);

      // successfully disconnect
      await dashboard.voluntaryDisconnect();

      // adding 1 ether to cover the exit fees
      await dashboard.fund({ value: ether("1") });

      // take the last fees from the post disconnect report (1.1 ether because fees are cumulative)
      await expect(
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValueOnRefSlot,
          accruedLidoFees: ether("1.1"),
        }),
      )
        .to.emit(vaultHub, "VaultObligationsSettled")
        .withArgs(stakingVaultAddress, 0n, ether("0.1"), 0n, 0n, ether("1.1"))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVaultAddress);

      // 0.9 ether should be left in the vault
      expect(await ethers.provider.getBalance(stakingVaultAddress)).to.equal(ether("0.9"));
    });
  });

  context("Beacon chain deposits", () => {
    it("Pauses deposits when unsettled fees are >= 1 ether", async () => {
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

    it("Resumes deposits when unsettled fees are < 1 ether", async () => {
      const accruedLidoFees = ether("1");

      await setBalance(stakingVaultAddress, 0); // dirty hack to make the vault balance 0
      await reportVaultDataWithProof(ctx, stakingVault, { accruedLidoFees });
      expect(await stakingVault.beaconChainDepositsPaused()).to.equal(true);

      await dashboard.fund({ value: ether("2") });

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
