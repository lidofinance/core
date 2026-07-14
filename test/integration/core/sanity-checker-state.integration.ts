import { expect } from "chai";
import { ZeroAddress } from "ethers";

import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { readNetworkState, Sk } from "lib/state-file";

import { Snapshot } from "test/suite";

/**
 * State checks for the deployed OracleReportSanityChecker. Its wiring and configuration
 * must match the recorded deploy state of the current network (scratch deploy or fork
 * after upgrade).
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

    // The network state file stores the limits list the checker was deployed with
    // (constructorArgs = [lidoLocator, accounting, admin, limitsList]). It is correct
    // for both environments: a scratch deploy writes it, and a fork upgrade re-deploys
    // the checker and writes the limits again. If the DAO later changes a limit on a
    // live network, this test fails on purpose: it is a signal that the config drifted.
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

  // The second opinion oracle is not set in the constructor and must stay unset after
  // deploy/upgrade. The negative-rebase tests depend on this: with no second opinion
  // oracle the checker reverts directly.
  it("Should have no second opinion oracle configured", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;

    expect(await oracleReportSanityChecker.secondOpinionOracle()).to.equal(ZeroAddress);
  });
});
