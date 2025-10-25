import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { advanceChainTime, MAX_UINT256 } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  DEFAULT_TIER_PARAMS,
  getProtocolContext,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: Vault with bad debt", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let otherOwner: HardhatEthersSigner;
  let daoAgent: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    const { lido, stakingVaultFactory, vaultHub } = ctx.contracts;
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, otherOwner, daoAgent] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    // Going to bad debt
    await dashboard.fund({ value: ether("10") }); // TV = 11 ETH
    await dashboard.mintShares(owner, await dashboard.remainingMintingCapacityShares(0n));

    // Slash 10 ETH
    await reportVaultDataWithProof(ctx, stakingVault, {
      totalValue: ether("1"),
      slashingReserve: ether("1"),
      waitForNextRefSlot: true,
    });

    expect(await dashboard.totalValue()).to.be.lessThan(
      await lido.getPooledEthBySharesRoundUp(await dashboard.liabilityShares()),
    );

    // Indicates bad debt
    expect(await vaultHub.healthShortfallShares(stakingVault)).to.be.equal(MAX_UINT256);

    // Grant a role to the DAO agent
    await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.BAD_DEBT_MASTER_ROLE(), daoAgent);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Socialization", () => {
    let acceptorStakingVault: StakingVault;
    let acceptorDashboard: Dashboard;

    beforeEach(async () => {
      const { stakingVaultFactory } = ctx.contracts;
      // create vault acceptor
      ({ stakingVault: acceptorStakingVault, dashboard: acceptorDashboard } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      ));
    });

    it("Vault's debt can be socialized", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);

      expect(await dashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "No more bad debt in vault",
      );

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      expect(await acceptorDashboard.liabilityShares()).to.be.equal(badDebtShares);
      expect(await vaultHub.isVaultHealthy(acceptorStakingVault)).to.be.equal(true);
    });

    it("Socialization bypasses jail restrictions", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido, operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Put acceptor vault in jail to test bypass functionality
      await operatorGrid.connect(agentSigner).setVaultJailStatus(acceptorStakingVault, true);
      expect(await operatorGrid.isVaultInJail(acceptorStakingVault)).to.be.true;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Socialization should succeed even though acceptor vault is in jail
      // because socializeBadDebt uses _overrideLimits: true
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);

      // Verify bad debt was transferred despite jail restriction
      expect(await acceptorDashboard.liabilityShares()).to.equal(badDebtShares);
      expect(await operatorGrid.isVaultInJail(acceptorStakingVault)).to.be.true; // Still in jail
    });

    it("Socialization doesn't lead to bad debt in acceptor", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("1") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(
        vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares),
      ).to.emit(vaultHub, "BadDebtSocialized");

      expect(await dashboard.liabilityShares()).to.be.greaterThan(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "Still some bad debt left",
      );

      expect(
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue())),
      ).to.be.lessThan(badDebtShares, "bad debt should decrease");

      expect(await vaultHub.isVaultHealthy(acceptorStakingVault)).to.be.equal(false);
      expect(await acceptorDashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await acceptorDashboard.totalValue()),
        "No bad debt in acceptor vault",
      );
    });

    it("Socialization lead to bad debt beacon chain deposits pause", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("2") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      expect(await acceptorStakingVault.beaconChainDepositsPaused()).to.be.false;

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .and.to.emit(acceptorStakingVault, "BeaconChainDepositsPaused");

      expect(await acceptorStakingVault.beaconChainDepositsPaused()).to.be.true;
    });

    it("OperatorGrid shareLimits can't prevent socialization", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      await setUpOperatorGrid(
        ctx,
        [nodeOperator],
        [{ noShareLimit: await acceptorDashboard.liabilityShares(), tiers: [DEFAULT_TIER_PARAMS] }],
      );
      await changeTier(ctx, acceptorDashboard, otherOwner, nodeOperator);

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);
    });

    it("Socialization requires fresh reports", async () => {
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Advance time to make report stale
      await advanceChainTime(await vaultHub.REPORT_FRESHNESS_DELTA());

      // Try to socialize with stale report - should fail
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(stakingVault);
    });

    it("Socialization only between same node operator", async () => {
      const { stakingVaultFactory, vaultHub, lido } = ctx.contracts;
      const [, , , , , differentOperator] = await ethers.getSigners();

      // Create acceptor vault with different node operator
      const { stakingVault: differentOpVault, dashboard: differentOpDashboard } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        differentOperator,
        differentOperator,
      );

      await differentOpDashboard.connect(otherOwner).fund({ value: ether("10") });

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      // Try to socialize between different operators - should fail
      await expect(
        vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, differentOpVault, badDebtShares),
      ).to.be.revertedWithCustomError(vaultHub, "BadDebtSocializationNotAllowed");

      // Verify socialization works with same operator
      await acceptorDashboard.connect(otherOwner).fund({ value: ether("10") });
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, acceptorStakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtSocialized")
        .withArgs(stakingVault, acceptorStakingVault, badDebtShares);
    });

    it("Multi-vault bad debt socialization scenario", async () => {
      const { stakingVaultFactory, vaultHub, lido } = ctx.contracts;

      // Create vault B and C (acceptors, same operator)
      const { stakingVault: vaultB, dashboard: dashboardB } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      );

      const { stakingVault: vaultC, dashboard: dashboardC } = await createVaultWithDashboard(
        ctx,
        stakingVaultFactory,
        otherOwner,
        nodeOperator,
        nodeOperator,
      );

      // Fund acceptor vaults with limited capacity
      const donorLiabilitySharesBefore = await dashboard.liabilityShares();
      await dashboardB.connect(otherOwner).fund({ value: donorLiabilitySharesBefore / 4n });
      await dashboardC.connect(otherOwner).fund({ value: donorLiabilitySharesBefore });

      const totalBadDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      const vaultBLiabilitySharesBefore = await dashboardB.liabilityShares();
      const vaultCLiabilitySharesBefore = await dashboardC.liabilityShares();

      // Calculate capacity for each acceptor (approximately half of total value in shares)
      const vaultBCapacity = await lido.getSharesByPooledEth(await dashboardB.totalValue());
      const vaultCCapacity = await lido.getSharesByPooledEth(await dashboardC.totalValue());

      // First socialization: transfer to vault B
      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, vaultB, totalBadDebtShares)).to.emit(
        vaultHub,
        "BadDebtSocialized",
      );

      const donorLiabilitySharesAfterFirst = await dashboard.liabilityShares();
      const vaultBLiabilitySharesAfterFirst = await dashboardB.liabilityShares();

      // Verify first transfer
      expect(donorLiabilitySharesAfterFirst).to.be.lessThan(donorLiabilitySharesBefore);
      expect(vaultBLiabilitySharesAfterFirst).to.be.greaterThan(vaultBLiabilitySharesBefore);
      expect(vaultBLiabilitySharesAfterFirst).to.be.lessThanOrEqual(vaultBCapacity, "Vault B shouldn't has bad debt");

      // Second socialization: transfer remaining to vault C
      const remainingBadDebt =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).socializeBadDebt(stakingVault, vaultC, remainingBadDebt)).to.emit(
        vaultHub,
        "BadDebtSocialized",
      );

      const donorLiabilitySharesAfterSecond = await dashboard.liabilityShares();
      const vaultCLiabilitySharesAfterSecond = await dashboardC.liabilityShares();

      // Verify second transfer
      expect(donorLiabilitySharesAfterSecond).to.be.lessThan(donorLiabilitySharesAfterFirst);
      expect(vaultCLiabilitySharesAfterSecond).to.be.greaterThan(vaultCLiabilitySharesBefore);
      expect(vaultCLiabilitySharesAfterSecond).to.be.lessThanOrEqual(vaultCCapacity, "Vault C shouldn't has bad debt");

      // Verify vault A is fully recovered from bad debt
      const finalBadDebt =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      expect(finalBadDebt).to.equal(0n, "Donor vault should be fully recovered");

      // Verify all liability shares are properly tracked
      const totalLiabilityAfter =
        (await dashboard.liabilityShares()) +
        (await dashboardB.liabilityShares()) +
        (await dashboardC.liabilityShares());

      const totalLiabilityBefore =
        donorLiabilitySharesBefore + vaultBLiabilitySharesBefore + vaultCLiabilitySharesBefore;

      expect(totalLiabilityAfter).to.equal(totalLiabilityBefore, "Total liability shares should be conserved");
    });
  });

  describe("Internalization", () => {
    it("Vault's bad debt can be internalized", async () => {
      const { vaultHub, lido } = ctx.contracts;

      const badDebtShares =
        (await dashboard.liabilityShares()) - (await lido.getSharesByPooledEth(await dashboard.totalValue()));

      await expect(vaultHub.connect(daoAgent).internalizeBadDebt(stakingVault, badDebtShares))
        .to.emit(vaultHub, "BadDebtWrittenOffToBeInternalized")
        .withArgs(stakingVault, badDebtShares);

      expect(await dashboard.liabilityShares()).to.be.lessThanOrEqual(
        await lido.getSharesByPooledEth(await dashboard.totalValue()),
        "No bad debt in vault",
      );

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.equal(false);

      await waitNextAvailableReportTime(ctx);
      expect(await vaultHub.badDebtToInternalize()).to.be.equal(badDebtShares);

      const { reportTx } = await report(ctx, { waitNextReportTime: false });
      await expect(reportTx)
        .to.emit(lido, "ExternalBadDebtInternalized")
        .withArgs(badDebtShares)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(badDebtShares);

      expect(await vaultHub.badDebtToInternalize()).to.be.equal(0n);
    });
  });
});
