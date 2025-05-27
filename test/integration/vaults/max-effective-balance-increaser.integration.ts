import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { EIP7251MaxEffectiveBalanceRequest__Mock } from "typechain-types";

import { deployEIP7251MaxEffectiveBalanceRequestContract } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { testEIP7251Mock } from "test/common/lib/triggerableWithdrawals/eip7251Mock";
import { generateConsolidationRequestPayload } from "test/common/lib/triggerableWithdrawals/utils";
import { Snapshot } from "test/suite";

describe("Integration: MaxEffectiveBalanceIncreaser", () => {
  let ctx: ProtocolContext;
  let consolidationRequestPredeployed: EIP7251MaxEffectiveBalanceRequest__Mock;
  let originalState: string;
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    consolidationRequestPredeployed = await deployEIP7251MaxEffectiveBalanceRequestContract(1n);
    ctx = await getProtocolContext();
    [owner, stranger] = await ethers.getSigners();
  });
  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("Consolidates validators by calling max effective balance increaser through contract using delegatecall", async () => {
    const { sourcePubkeys, targetPubkeys, totalSourcePubkeysCount } = generateConsolidationRequestPayload(1);

    const delegateCaller = await ethers.deployContract("DelegateCaller", [], { from: owner });
    const delegateCallerAddress = await delegateCaller.getAddress();

    const feeForRequest = 10n;
    const totalFee = BigInt(totalSourcePubkeysCount) * feeForRequest;
    await consolidationRequestPredeployed.mock__setFee(feeForRequest);

    await testEIP7251Mock(
      () =>
        delegateCaller.callDelegate(
          ctx.contracts.maxEffectiveBalanceIncreaser.address,
          ctx.contracts.maxEffectiveBalanceIncreaser.interface.encodeFunctionData("addConsolidationRequests", [
            sourcePubkeys,
            targetPubkeys,
            stranger.address,
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
