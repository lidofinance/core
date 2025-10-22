import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { ether } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

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
    await setupLidoForVaults(ctx);

    [, owner, nodeOperator] = await ethers.getSigners();

    const { stakingVaultFactory, vaultHub } = ctx.contracts;

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
    await dashboard.fund({ value: ether("1") });
    expect(await vaultHub.totalValue(stakingVault)).to.be.equal(ether("2"));
    expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  it("Report with non-zero slashing reserve updates the minimal reserve", async () => {
    const { vaultHub } = ctx.contracts;

    await reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("2") });

    // check minimal reserve in the record
    const record = await vaultHub.vaultRecord(stakingVault);
    expect(record.minimalReserve).to.be.equal(ether("2"));

    // check locked amount
    expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("2"));
  });

  it("Report with zero slashing reserve resets the minimal reserve to CONNECT_DEPOSIT", async () => {
    const { vaultHub } = ctx.contracts;

    await reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("2") });

    let record = await vaultHub.vaultRecord(stakingVault);
    expect(record.minimalReserve).to.be.equal(ether("2"));
    expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("2"));

    await reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("0") });

    record = await vaultHub.vaultRecord(stakingVault);
    expect(record.minimalReserve).to.be.equal(ether("1"));
    expect(await vaultHub.locked(stakingVault)).to.be.equal(ether("1"));
  });

  it("You cannot withdraw reported slashing reserve", async () => {
    const { vaultHub } = ctx.contracts;

    await reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("2") });

    expect(await vaultHub.withdrawableValue(stakingVault)).to.be.equal(0);

    await expect(dashboard.withdraw(owner, ether("1"))).to.be.revertedWithCustomError(dashboard, "ExceedsWithdrawable");
  });

  it("You cannot mint StETH over slashing reserve", async () => {
    await reportVaultDataWithProof(ctx, stakingVault, { slashingReserve: ether("2") });

    await expect(dashboard.mintStETH(owner, ether("0.1"))).to.be.revertedWithCustomError(
      dashboard,
      "ExceedsMintingCapacity",
    );
  });
});
