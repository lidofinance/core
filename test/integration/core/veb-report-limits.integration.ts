import { expect } from "chai";
import { ethers } from "hardhat";

import {
  getProtocolContext,
  ProtocolContext,
  submitVebReportWithConsensus,
  updateOracleReportLimits,
} from "lib/protocol";
import { NOR_MODULE_ID } from "lib/protocol/helpers/staking-module";

import { Snapshot } from "test/suite";

/**
 * Integration test for the exit-balance limit of the sanity checker, exercised through
 * the real ValidatorsExitBusOracle consensus path:
 * HashConsensus -> ValidatorsExitBusOracle.submitReportData -> sanity checker.
 *
 * `checkExitBusOracleReport` runs before the per-request key verification, so the report
 * only needs a real module id: each request contributes the module's max effective
 * balance weight (32 ETH for WC 0x01 modules like NOR) to the checked sum.
 */
describe("Integration: ValidatorsExitBusOracle report limits", () => {
  let ctx: ProtocolContext;

  let snapshot: string;
  let originalState: string;

  before(async () => {
    ctx = await getProtocolContext();
    snapshot = await Snapshot.take();
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  after(async () => await Snapshot.restore(snapshot));

  it("Should revert with IncorrectSumOfExitBalancePerReport when the exit balance sum exceeds the limit", async () => {
    const { oracleReportSanityChecker } = ctx.contracts;

    // With a zeroed limit a single NOR exit request (32 ETH weight) trips the check
    await updateOracleReportLimits(ctx, { maxBalanceExitRequestedPerReportInEth: 0n });

    const expectedBalanceSumEth = (await oracleReportSanityChecker.getOracleReportLimits())
      .maxEffectiveBalanceWeightWCType01;

    await expect(
      submitVebReportWithConsensus(ctx, [
        {
          moduleId: NOR_MODULE_ID,
          nodeOpId: 0n,
          validatorIndex: 0n,
          keyIndex: 0n,
          pubkey: ethers.hexlify(ethers.randomBytes(48)),
        },
      ]),
    )
      .to.be.revertedWithCustomError(oracleReportSanityChecker, "IncorrectSumOfExitBalancePerReport")
      .withArgs(expectedBalanceSumEth);
  });
});
