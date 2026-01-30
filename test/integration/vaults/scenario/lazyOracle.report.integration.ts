import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { MAX_SANE_SETTLED_GROWTH } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { advanceChainTime } from "lib/time";

import { bailOnFailure, Snapshot } from "test/suite";

describe("Scenario: Lazy Oracle prevents overwriting freshly reconnected vault report", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [, owner, nodeOperator] = await ethers.getSigners();
  });

  beforeEach(bailOnFailure);

  after(async () => await Snapshot.restore(snapshot));

  it("Vault report can't be overwritten if vault is reconnected", async () => {
    const { stakingVaultFactory, vaultHub, lazyOracle } = ctx.contracts;

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    await dashboard.connect(owner).voluntaryDisconnect();
    await reportVaultDataWithProof(ctx, stakingVault);

    expect(await lazyOracle.latestReportTimestamp()).to.be.greaterThan(0);
    expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

    await dashboard.connect(owner).correctSettledGrowth(0, MAX_SANE_SETTLED_GROWTH);
    await dashboard.connect(nodeOperator).correctSettledGrowth(0, MAX_SANE_SETTLED_GROWTH);

    await dashboard.connect(owner).reconnectToVaultHub();

    await expect(
      reportVaultDataWithProof(ctx, stakingVault, { updateReportData: false }),
    ).to.be.revertedWithCustomError(lazyOracle, "VaultReportIsFreshEnough");
  });

  it("Even if AO skipped for 2 days", async () => {
    const { vaultHub, lazyOracle } = ctx.contracts;
    await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);

    await expect(
      reportVaultDataWithProof(ctx, stakingVault, { updateReportData: false }),
    ).to.be.revertedWithCustomError(lazyOracle, "VaultReportIsFreshEnough");
  });
});
