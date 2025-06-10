import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard,EIP7251MaxEffectiveBalanceRequest__Mock } from "typechain-types";

import { deployEIP7251MaxEffectiveBalanceRequestContract } from "lib";
import { createVaultWithDashboard,getProtocolContext, ProtocolContext } from "lib/protocol";

import { generateConsolidationRequestPayload } from "test/0.8.25/vaults/consolidation/consolidation_utils";
import { testEIP7251Mock } from "test/0.8.25/vaults/consolidation/eip7251Mock";
import { Snapshot } from "test/suite";

describe("Integration: ValidatorConsolidationRequests", () => {
  let ctx: ProtocolContext;
  let consolidationRequestPredeployed: EIP7251MaxEffectiveBalanceRequest__Mock;
  let originalState: string;
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let dashboard: Dashboard;

  before(async () => {
    consolidationRequestPredeployed = await deployEIP7251MaxEffectiveBalanceRequestContract(1n);
    ctx = await getProtocolContext();
    [owner, stranger, nodeOperator] = await ethers.getSigners();

    ({ dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));
  });
  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("Consolidates validators by calling max effective balance increaser through contract using delegatecall", async () => {
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount, adjustmentIncreases } =
      generateConsolidationRequestPayload(1);

    const delegateCaller = await ethers.deployContract("DelegateCaller", [], { from: owner });
    const delegateCallerAddress = await delegateCaller.getAddress();

    const feeForRequest = 10n;
    const totalFee = BigInt(totalSourcePubkeysCount) * feeForRequest;
    await consolidationRequestPredeployed.mock__setFee(feeForRequest);
    const dashboardAddress = await dashboard.getAddress();

    await dashboard
      .connect(nodeOperator)
      .grantRole(await dashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), delegateCallerAddress);

    await testEIP7251Mock(
      () =>
        delegateCaller.callDelegate(
          ctx.contracts.validatorConsolidationRequests.address,
          ctx.contracts.validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
            sourcePubkeys,
            targetPubkeys,
            stranger.address,
            dashboardAddress,
            adjustmentIncreases,
          ]),
          { value: totalFee },
        ),
      delegateCallerAddress,
      sourcePubkeys,
      targetPubkeys,
      feeForRequest,
    );
  });
});
