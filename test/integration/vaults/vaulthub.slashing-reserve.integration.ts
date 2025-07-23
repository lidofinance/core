import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { ether } from "lib";
import { createVaultWithDashboard, getProtocolContext, ProtocolContext, reportVaultDataWithProof } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Scenario: Vault Report Slashing Reserve", () => {
  let ctx: ProtocolContext;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [, owner, nodeOperator] = await ethers.getSigners();

    const { stakingVaultFactory } = ctx.contracts;

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  it("You cannot withdraw reported slashing reserve", async () => {
    const { vaultHub } = ctx.contracts;

    await dashboard.fund({ value: ether("1") });
    expect(await vaultHub.totalValue(stakingVault)).to.be.equal(ether("2"));
    expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));

    await reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("2") });

    expect(await vaultHub.withdrawableValue(stakingVault)).to.be.equal(0);

    await expect(dashboard.withdraw(owner, ether("1"))).to.be.revertedWithCustomError(vaultHub, "ExceedsWithdrawable");
  });

  it("You cannot disconnect if slashing reserve is not zero", async () => {});

  it("Pending disconnect is aborted if slashing reserve is not zero", async () => {});
});
