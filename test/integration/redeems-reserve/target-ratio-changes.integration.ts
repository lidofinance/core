import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import {
  assertReserveAllocationInvariant,
  assertReserveState,
  captureState,
  doReport,
  expectedReserveTarget,
  seedReserve,
  setupVault,
  VaultFixture,
} from "./helpers";

const DEPOSIT = ether("1000");
const INITIAL_RATIO_BP = 500n;

describe("Integration: Redeems reserve — target ratio changes mid-cycle", () => {
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

    await seedReserve(ctx, holder, reserveManager, { deposit: DEPOSIT, redeemsReserveRatioBP: INITIAL_RATIO_BP });
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("lowering target ratio shrinks reserve on next report, unredeemed ETH returned to Lido", async () => {
    const { lido } = ctx.contracts;

    const stateBefore = await captureState(lido);
    assertReserveState(stateBefore, INITIAL_RATIO_BP);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(stateBefore.reserve);

    const LOWER_RATIO_BP = 200n;
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(LOWER_RATIO_BP);

    await doReport(ctx);

    const stateAfter = await captureState(lido);
    const expectedTarget = expectedReserveTarget(stateAfter.internalEther, LOWER_RATIO_BP);

    assertReserveState(stateAfter, LOWER_RATIO_BP);
    expect(stateAfter.reserve).to.equal(expectedTarget);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(expectedTarget);

    await assertReserveAllocationInvariant(lido);
  });

  it("raising target ratio grows reserve to new target on next report when surplus is enough", async () => {
    const { lido } = ctx.contracts;

    const stateBefore = await captureState(lido);
    assertReserveState(stateBefore, INITIAL_RATIO_BP);

    const HIGHER_RATIO_BP = 1000n;
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(HIGHER_RATIO_BP);

    await doReport(ctx);

    const stateAfter = await captureState(lido);
    const expectedTarget = expectedReserveTarget(stateAfter.internalEther, HIGHER_RATIO_BP);

    // Seeded deposit (1000 ETH) has enough unreserved to fill a reserve at 10% of internal ether in a single report.
    assertReserveState(stateAfter, HIGHER_RATIO_BP);
    expect(stateAfter.reserve).to.equal(expectedTarget);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(expectedTarget);

    await assertReserveAllocationInvariant(lido);
  });

  it("setting target ratio to zero drains reserve and skips fundReserve", async () => {
    const { lido } = ctx.contracts;

    const stateBefore = await captureState(lido);
    assertReserveState(stateBefore, INITIAL_RATIO_BP);

    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(0n);

    await doReport(ctx);

    const stateAfter = await captureState(lido);

    expect(stateAfter.reserveTarget).to.equal(0n);
    expect(stateAfter.reserve).to.equal(0n);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(0n);

    await assertReserveAllocationInvariant(lido);
  });

  it("deactivate then reactivate: ratio 500 → 0 → 500 refills reserve on next report", async () => {
    const { lido } = ctx.contracts;

    // Deactivate
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(0n);
    await doReport(ctx);
    const stateOff = await captureState(lido);
    expect(stateOff.reserve).to.equal(0n);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(0n);

    // Reactivate
    await lido.connect(reserveManager).setRedeemsReserveTargetRatio(INITIAL_RATIO_BP);
    await doReport(ctx);

    const stateBack = await captureState(lido);
    expect(stateBack.reserveTarget).to.equal(expectedReserveTarget(stateBack.internalEther, INITIAL_RATIO_BP));
    expect(stateBack.reserve).to.equal(stateBack.reserveTarget);
    expect(await ethers.provider.getBalance(fix.address)).to.equal(stateBack.reserve);

    await assertReserveAllocationInvariant(lido);
  });
});
