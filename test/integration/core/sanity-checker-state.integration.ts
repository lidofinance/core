import { expect } from "chai";
import { ZeroAddress } from "ethers";

import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

/**
 * Integration state checks for the deployed OracleReportSanityChecker: wiring and
 * configuration must match the recorded deploy state of the current network
 * (scratch deploy or fork after upgrade).
 */
describe("Integration: OracleReportSanityChecker state", () => {
  let ctx: ProtocolContext;

  let snapshot: string;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should be wired to the protocol LidoLocator", async () => {
    const { oracleReportSanityChecker, locator } = ctx.contracts;

    expect(await oracleReportSanityChecker.getLidoLocator()).to.equal(locator.address);
  });

  it("Should expose the oracle report limits the checker was deployed with", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;

    // The network state file records the limits list the checker was constructed with:
    // constructorArgs = [lidoLocator, accounting, admin, limitsList]
    const state = readNetworkState();
    const expectedLimits: Record<string, number> = state[Sk.oracleReportSanityChecker].constructorArgs[3];
    expect(Object.keys(expectedLimits).length).to.equal(16, "expected the full limits list in the deploy state");

    const limits = await oracleReportSanityChecker.getOracleReportLimits();

    for (const [field, expectedValue] of Object.entries(expectedLimits)) {
      expect(limits[field as keyof typeof limits]).to.equal(
        BigInt(expectedValue),
        `limit ${field} does not match the deployed configuration`,
      );
    }
  });

  it("Should have no second opinion oracle configured", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;

    expect(await oracleReportSanityChecker.secondOpinionOracle()).to.equal(ZeroAddress);
  });
});
