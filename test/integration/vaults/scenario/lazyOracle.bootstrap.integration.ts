import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Scenario: Lazy Oracle after mainnet upgrade before the first report", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [, owner, nodeOperator] = await ethers.getSigners();
  });

  after(async () => await Snapshot.restore(snapshot));

  // TODO: move to acceptance?
  it("Vault report is not fresh on upgrade", async function () {
    const { stakingVaultFactory, vaultHub, lazyOracle } = ctx.contracts;

    if ((await lazyOracle.latestReportData()).timestamp != 0n) {
      console.log("LazyOracle report is not fresh on upgrade");
      this.skip();
    }

    const { stakingVault } = await createVaultWithDashboard(
      ctx,
      stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    );

    expect(await vaultHub.isReportFresh(stakingVault)).to.be.false;
    await report(ctx);
    expect(await vaultHub.isReportFresh(stakingVault)).to.be.false;
    await reportVaultDataWithProof(ctx, stakingVault);
    expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
  });
});
