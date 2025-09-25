import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard } from "typechain-types";

import { createVaultWithDashboard, getProtocolContext, ProtocolContext } from "lib/protocol";

import { generateConsolidationRequestPayload } from "test/0.8.25/vaults/consolidation/consolidationHelper";
import { Snapshot } from "test/suite";

const KEY_LENGTH = 48;

describe("Integration: ValidatorConsolidationRequests", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [owner, nodeOperator] = await ethers.getSigners();

    ({ dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  it("Consolidates validators by calling addConsolidationRequestsAndIncreaseRewardsAdjustment", async () => {
    const { validatorConsolidationRequests } = ctx.contracts;

    const { sourcePubkeys, targetPubkeys, adjustmentIncrease } = generateConsolidationRequestPayload(1);

    const dashboardAddress = await dashboard.getAddress();
    await dashboard
      .connect(nodeOperator)
      .grantRole(await dashboard.NODE_OPERATOR_FEE_EXEMPT_ROLE(), validatorConsolidationRequests);

    const { feeExemptionEncodedCall, consolidationRequestEncodedCalls } =
      await validatorConsolidationRequests.getConsolidationRequestsAndFeeExemptionEncodedCalls(
        sourcePubkeys,
        targetPubkeys,
        dashboardAddress,
        adjustmentIncrease,
      );

    // verify mainnet format of the events, on scratch we use a mock, so no need to verify anything except the number
    if (!ctx.isScratch) {
      let k = 0;
      for (let i = 0; i < targetPubkeys.length; i++) {
        const sourcePubkeysCount = sourcePubkeys[i].length / KEY_LENGTH;
        for (let j = 0; j < sourcePubkeysCount; j++) {
          const targetPubkey = targetPubkeys[i];
          const sourcePubkey = sourcePubkeys[i].slice(j * KEY_LENGTH, (j + 1) * KEY_LENGTH);
          const concatenatedKeys = ethers.hexlify(sourcePubkey) + ethers.hexlify(targetPubkey).slice(2);
          expect(consolidationRequestEncodedCalls[k]).to.equal(concatenatedKeys);
          expect(consolidationRequestEncodedCalls[k].length).to.equal(2 + KEY_LENGTH * 2 + KEY_LENGTH * 2);
          k++;
        }
      }
      const iface = new ethers.Interface(["function addFeeExemption(uint256)"]);
      const calldata = iface.encodeFunctionData("addFeeExemption", [adjustmentIncrease]);
      expect(feeExemptionEncodedCall).to.equal(calldata);
    }
  });
});
