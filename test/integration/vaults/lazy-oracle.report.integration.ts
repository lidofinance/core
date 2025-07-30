import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { advanceChainTime } from "lib";
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

    await advanceChainTime(60n);
    // TODO: find out why without time advance there is VaultReportIsFreshEnough although vaultHub.isReportFresh is false
    await reportVaultDataWithProof(ctx, stakingVault);
    await dashboard.connect(owner).voluntaryDisconnect();
    await reportVaultDataWithProof(ctx, stakingVault);

    expect(await lazyOracle.latestReportTimestamp()).to.be.greaterThan(0);
    expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

    await dashboard.connect(owner).reconnectToVaultHub();

    await expect(reportVaultDataWithProof(ctx, stakingVault, {}, false)).to.be.revertedWithCustomError(
      lazyOracle,
      "VaultReportIsFreshEnough",
    );
  });
});
