import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { MAX_UINT256 } from "lib";
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
    expect(await vaultHub.rebalanceShortfallShares(stakingVault)).to.be.equal(MAX_UINT256);

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
