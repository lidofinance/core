import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether, impersonate } from "lib";
import {
  getProtocolContext,
  ProtocolContext,
  report,
  submitReportDataWithConsensus,
  waitNextAvailableReportTime,
} from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  mineBlocks,
  redeemExact,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const RATIO_BP = 500n;
const REDEEM = ether("1");

describe("Integration: Redeems reserve — lowering target while a post-refSlot redeem is carried", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let reserveManager: HardhatEthersSigner;
  let holder: HardhatEthersSigner;

  let fix: VaultFixture;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder] = await ethers.getSigners();
    reserveManager = holder;

    const { acl, lido } = ctx.contracts;
    const agent = await ctx.getSigner("agent");
    const role = await lido.BUFFER_RESERVE_MANAGER_ROLE();
    const hasRole = await acl["hasPermission(address,address,bytes32)"](reserveManager.address, lido.address, role);
    if (!hasRole) {
      await acl.connect(agent).grantPermission(reserveManager.address, lido.address, role);
    }

    fix = await setupVault(ctx, reserveManager);
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: RATIO_BP });
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("next report must not revert in buffer.reconcile after target drops to 0", async () => {
    const { lido, accountingOracle, hashConsensus } = ctx.contracts;

    const { reportRefSlot } = await waitNextAvailableReportTime(ctx);
    await mineBlocks(3);

    const expectedShares = await lido.getSharesByPooledEth(REDEEM);
    const expectedEther = await lido.getPooledEthByShares(expectedShares);

    await redeemExact(lido, holder, fix, REDEEM);

    const [liveEther, liveShares] = await fix.vault.getRedeemed();
    expect(liveEther).to.equal(expectedEther);
    expect(liveShares).to.equal(expectedShares);
    expect(await fix.vault.getRedeemedForLastRefSlot()).to.deep.equal([0n, 0n]);

    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(0n);

    const dry = await report(ctx, {
      clDiff: 0n,
      excludeVaultsBalances: true,
      skipWithdrawals: true,
      refSlot: reportRefSlot,
      waitNextReportTime: false,
      dryRun: true,
    });

    await submitReportDataWithConsensus(ctx, dry.data);

    const { addresses } = await hashConsensus.getFastLaneMembers();
    const member = await impersonate(addresses[0], ether("1"));
    await accountingOracle.connect(member).submitReportExtraDataEmpty();

    expect(await lido.getRedeemsReserveTarget()).to.equal(0n);
    expect(await lido.getRedeemsReserve()).to.equal(liveEther);
    expect(await fix.vault.getReserveBalance()).to.equal(liveEther);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(liveEther);

    expect(await fix.vault.getRedeemed()).to.deep.equal([liveEther, liveShares]);

    await assertReserveAllocationInvariant(lido);
  });
});
