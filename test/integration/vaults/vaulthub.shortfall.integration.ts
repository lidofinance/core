import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { impersonate } from "lib";
import { createVaultWithDashboard, getProtocolContext, ProtocolContext, setupLidoForVaults } from "lib/protocol";
import { ensureExactShareRate, reportVaultDataWithProof } from "lib/protocol/helpers";
import { ether } from "lib/units";

import { SHARE_RATE_PRECISION, Snapshot } from "test/suite";

describe("Integration: VaultHub Shortfall", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator] = await ethers.getSigners();
    agentSigner = await ctx.getSigner("agent");
    await setupLidoForVaults(ctx);

    await ensureExactShareRate(ctx, (12737625930792815n * SHARE_RATE_PRECISION) / 10000000000000000n);
  });

  async function setup({ rr, frt }: { rr: bigint; frt: bigint }) {
    const { stakingVaultFactory, operatorGrid, vaultHub } = ctx.contracts;
    const { stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    );

    await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("5000"));
    const tier = {
      shareLimit: ether("1000"),
      reserveRatioBP: rr,
      forcedRebalanceThresholdBP: frt,
      infraFeeBP: 0,
      liquidityFeeBP: 0,
      reservationFeeBP: 0,
    };

    await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [tier]);
    const beforeInfo = await operatorGrid.vaultTierInfo(stakingVault);
    expect(beforeInfo.tierId).to.equal(0n);

    const requestedTierId = (await operatorGrid.group(nodeOperator)).tierIds[0];
    const requestedShareLimit = ether("1000");

    // First confirmation from vault owner via Dashboard → returns false (not yet confirmed)
    await dashboard.connect(owner).changeTier(requestedTierId, requestedShareLimit);

    // Second confirmation from node operator → completes and updates connection
    await operatorGrid.connect(nodeOperator).changeTier(stakingVault, requestedTierId, requestedShareLimit);

    const afterInfo = await operatorGrid.vaultTierInfo(stakingVault);
    expect(afterInfo.tierId).to.equal(requestedTierId);

    const connection = await vaultHub.vaultConnection(stakingVault);
    expect(connection.shareLimit).to.equal(tier.shareLimit);
    expect(connection.reserveRatioBP).to.equal(tier.reserveRatioBP);
    expect(connection.forcedRebalanceThresholdBP).to.equal(tier.forcedRebalanceThresholdBP);

    const dashboardSigner = await impersonate(dashboard, ether("10000"));

    return {
      stakingVault,
      dashboard: dashboard.connect(owner),
      vaultHub: vaultHub.connect(dashboardSigner),
    };
  }

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("Shortfall", () => {
    it("Works on larger numbers", async () => {
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 2000n, frt: 1989n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, ether("0.689"));

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall + 1n);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on max capacity", async () => {
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 1000n, frt: 800n });
      await vaultHub.fund(stakingVault, { value: ether("9") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("10"));

      const maxShares = await dashboard.remainingMintingCapacityShares(0);

      await dashboard.mintShares(owner, maxShares);

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: (ether("10") * 95n) / 100n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on (TV=1000, LS=689, rr=2000 frt=1999) and shareRate 1.162518454795922", async () => {
      await ensureExactShareRate(ctx, (1162518454795922n * SHARE_RATE_PRECISION) / 1000000000000000n);
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 2000n, frt: 1989n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 699n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 1000n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on (TV=1000, LS=235, rr=2000 frt=1989) and shareRate 1.162518454795922", async () => {
      await ensureExactShareRate(ctx, (1162518454795922n * SHARE_RATE_PRECISION) / 1000000000000000n);
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 2000n, frt: 1989n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 699n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 1000n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on really small numbers", async () => {
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 2000n, frt: 1989n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 1n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 2n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall).to.equal(1n);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on numbers less than 10", async () => {
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 2000n, frt: 1989n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 7n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 10n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on hundreds", async () => {
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 2000n, frt: 1989n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 70n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 100n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(shortfall2).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
    });

    it("Works on (TV=22, LS=11, rr=frt=499) and shareRate 1.90909", async () => {
      await ensureExactShareRate(ctx, (190909n * SHARE_RATE_PRECISION) / 100000n);

      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 500n, frt: 489n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 11n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 22n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
      expect(shortfall2).to.equal(0n);
    });

    it("Works on (TV=15, LS=12, rr=772 frt=769) and shareRate 1.125", async () => {
      await ensureExactShareRate(ctx, (112500n * SHARE_RATE_PRECISION) / 100000n);
      const { stakingVault, dashboard, vaultHub } = await setup({ rr: 772n, frt: 761n });

      await vaultHub.fund(stakingVault, { value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.mintShares(owner, 12n);

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: 15n,
        waitForNextRefSlot: true,
      });

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;
      const shortfall = await vaultHub.healthShortfallShares(stakingVault);
      await dashboard.connect(owner).rebalanceVaultWithShares(shortfall);
      const shortfall2 = await vaultHub.healthShortfallShares(stakingVault);
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;
      expect(shortfall2).to.equal(0n);
    });
  });
});
