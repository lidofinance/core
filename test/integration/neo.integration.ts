import { expect } from "chai";

import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

describe("The one test for CI", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should be successful", async () => {
    const { lido } = ctx.contracts;

    const one = await lido.balanceOf("0x0000000000000000000000000000000000000042");
    const two = await lido.balanceOf("0x0000000000000000000000000000000000000043");

    expect(one).to.be.equal(0n);
    expect(two).to.be.equal(0n);
  });
});
