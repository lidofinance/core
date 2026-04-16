import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ether } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

import { assertReserveAllocationInvariant, captureState, doReport, installRedeemsBufferOnLocator } from "./helpers";

const DEPOSIT = ether("1000");

describe("Integration: Redeems reserve — feature disabled (no buffer in locator)", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let testSnapshot: string;

  let holder: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();

    [holder] = await ethers.getSigners();
  });

  beforeEach(async () => {
    await ethers.provider.send("hardhat_setNextBlockBaseFeePerGas", ["0x0"]);
    testSnapshot = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(testSnapshot);
  });

  after(async () => {
    await Snapshot.restore(snapshot);
  });

  it("oracle report processes as a pass-through when redeemsBuffer is not installed", async () => {
    const { lido, locator } = ctx.contracts;

    await installRedeemsBufferOnLocator(ctx, ZeroAddress);
    expect(await locator.redeemsBuffer()).to.equal(ZeroAddress);

    const stateBefore = await captureState(lido);
    expect(stateBefore.reserve).to.equal(0n);
    expect(stateBefore.reserveTarget).to.equal(0n);

    await lido.connect(holder).submit(ZeroAddress, { value: DEPOSIT });

    await doReport(ctx);

    const stateAfter = await captureState(lido);

    // Reserve machinery is inert — no target computed, no physical reserve anywhere.
    expect(stateAfter.reserve).to.equal(0n);
    expect(stateAfter.reserveTarget).to.equal(0n);

    // Allocation invariant still holds (reserve bucket is zero).
    await assertReserveAllocationInvariant(lido);
  });
});
