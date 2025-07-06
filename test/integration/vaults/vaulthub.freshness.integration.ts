import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingVault } from "typechain-types";

import { advanceChainTime, days } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  waitNextAvailableReportTime,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Scenario: Vault Report Freshness Check", () => {
  let ctx: ProtocolContext;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  let stakingVault: StakingVault;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    [, owner, nodeOperator] = await ethers.getSigners();
  });

  beforeEach(async () => {
    snapshot = await Snapshot.take();
  });

  afterEach(async () => await Snapshot.restore(snapshot));

  it("Vault is created with fresh report", async () => {
    const { stakingVaultFactory, vaultHub } = ctx.contracts;

    ({ stakingVault } = await createVaultWithDashboard(ctx, stakingVaultFactory, owner, nodeOperator, nodeOperator));

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
  });

  it.skip("Vault is created with fresh report after refSlot but before report", async () => {
    // TODO: fix this
    const { stakingVaultFactory, vaultHub } = ctx.contracts;

    await waitNextAvailableReportTime(ctx);

    ({ stakingVault } = await createVaultWithDashboard(ctx, stakingVaultFactory, owner, nodeOperator, nodeOperator));

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;

    await report(ctx, { clDiff: ether("0"), waitNextReportTime: false });

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
  });

  it("Vault freshness is expiring after 2 days after report", async () => {
    const { stakingVaultFactory, vaultHub } = ctx.contracts;

    ({ stakingVault } = await createVaultWithDashboard(ctx, stakingVaultFactory, owner, nodeOperator, nodeOperator));

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;

    await advanceChainTime(days(2n));

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.false;
  });

  it("Vault freshness is expiring after the next report", async () => {
    const { stakingVaultFactory, vaultHub } = ctx.contracts;

    ({ stakingVault } = await createVaultWithDashboard(ctx, stakingVaultFactory, owner, nodeOperator, nodeOperator));

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;

    await report(ctx, { clDiff: ether("0"), waitNextReportTime: true });

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.false;
  });
});
