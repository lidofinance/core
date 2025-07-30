import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { createVaultWithDashboard, getProtocolContext, ProtocolContext, reportVaultDataWithProof } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Scenario: Lazy Oracle update vault data", () => {
  let ctx: ProtocolContext;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [, owner, nodeOperator] = await ethers.getSigners();
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  it("Vault report can't be overwritten if vault is reconnected", async () => {
    const { stakingVaultFactory, vaultHub, lazyOracle } = ctx.contracts;

    const { stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    );

    await reportVaultDataWithProof(ctx, stakingVault);
    await dashboard.connect(owner).voluntaryDisconnect();

    expect(await lazyOracle.latestReportTimestamp()).to.be.greaterThan(0);
    expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

    await dashboard.connect(owner).reconnectToVaultHub();

    await expect(reportVaultDataWithProof(ctx, stakingVault, {}, false)).to.be.revertedWithCustomError(
      lazyOracle,
      "VaultReportIsFreshEnough",
    );
  });
});
