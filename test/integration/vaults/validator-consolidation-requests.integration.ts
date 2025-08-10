import { expect } from "chai";
import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault } from "typechain-types";

import { EIP7251_ADDRESS } from "lib";
import { createVaultWithDashboard, getProtocolContext, ProtocolContext } from "lib/protocol";

import { generateConsolidationRequestPayload } from "test/0.8.25/vaults/consolidation/consolidationHelper";
import { Snapshot } from "test/suite";

const KEY_LENGTH = 48;

describe("Integration: ValidatorConsolidationRequests", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let dashboard: Dashboard;
  let stakingVault: StakingVault;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [owner, stranger, nodeOperator] = await ethers.getSigners();

    ({ dashboard, stakingVault } = await createVaultWithDashboard(
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

  it("Consolidates validators by calling max effective balance increaser through contract using delegatecall", async () => {
    const { validatorConsolidationRequests } = ctx.contracts;

    const payload = generateConsolidationRequestPayload(1);
    const { sourcePubkeys, targetPubkeys } = payload;

    const delegateCaller = await ethers.deployContract("DelegateCaller", [], { from: owner });
    const delegateCallerAddress = await delegateCaller.getAddress();
    const stakingVaultAddress = await stakingVault.getAddress();

    // send empty tx to EIP7251 to get fee per request
    const feeForRequest = BigInt(await ethers.provider.call({ to: EIP7251_ADDRESS, data: "0x" }));
    const totalFee = BigInt(payload.totalSourcePubkeysCount) * feeForRequest;

    await dashboard
      .connect(nodeOperator)
      .grantRole(await dashboard.NODE_OPERATOR_REWARDS_ADJUST_ROLE(), delegateCallerAddress);

    const tx = await delegateCaller.callDelegate(
      validatorConsolidationRequests.address,
      validatorConsolidationRequests.interface.encodeFunctionData("addConsolidationRequests", [
        sourcePubkeys,
        targetPubkeys,
        stranger.address,
        stakingVaultAddress,
        payload.adjustmentIncrease,
      ]),
      { value: totalFee },
    );
    const receipt = (await tx.wait()) as ContractTransactionReceipt;

    const totalPubkeysCount = sourcePubkeys.reduce(
      (acc, pubkeys) => acc + BigInt(Math.floor(pubkeys.length / KEY_LENGTH)),
      0n,
    );

    const eip7251Events = receipt.logs.filter((log) => log.address === EIP7251_ADDRESS);
    expect(eip7251Events.length).to.equal(totalPubkeysCount);

    // verify mainnet format of the events, on scratch we use a mock, so no need to verify anything except the number
    if (!ctx.isScratch) {
      for (let i = 0; i < sourcePubkeys.length; i++) {
        const pubkeysCount = Math.floor(sourcePubkeys[i].length / KEY_LENGTH);
        for (let j = 0; j < pubkeysCount; j++) {
          const expectedSourcePubkey = sourcePubkeys[i].slice(j * KEY_LENGTH, (j + 1) * KEY_LENGTH);
          const result = ethers.concat([delegateCallerAddress, expectedSourcePubkey, targetPubkeys[i]]);
          expect(eip7251Events[i * pubkeysCount + j].data).to.equal(result);
        }
      }
    }
  });
});
