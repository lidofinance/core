import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { MAX_UINT256 } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
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
    expect(await vaultHub.rebalanceShortfall(stakingVault)).to.be.equal(MAX_UINT256);

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

    it.skip("Socialization doesn't lead to bad debt in acceptor", async () => {
      // TODO: fix this test
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
  });
});
