import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ConsolidationGateway } from "typechain-types";

import { findEventsWithInterfaces } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";

import { Snapshot } from "test/suite";

/**
 * Integration test for the consolidation request flow through ConsolidationGateway.
 *
 * The flow tested:
 * 1. ConsolidationGateway receives consolidation requests with proper authorization
 * 2. ConsolidationGateway validates input and consumes rate limit
 * 3. ConsolidationGateway forwards requests and fees to WithdrawalVault
 * 4. WithdrawalVault processes EIP-7251 consolidation requests
 */
describe("Integration: Consolidation requests", () => {
  let ctx: ProtocolContext;
  let consolidationGateway: ConsolidationGateway;
  let requestor: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;

  // Test data - sample validator public keys (48 bytes each)
  const sourcePubkey1 = "0x" + "a".repeat(96); // 48 bytes
  const sourcePubkey2 = "0x" + "b".repeat(96); // 48 bytes
  const targetPubkey1 = "0x" + "c".repeat(96); // 48 bytes
  const targetPubkey2 = "0x" + "d".repeat(96); // 48 bytes

  before(async () => {
    ctx = await getProtocolContext();
    [, requestor, stranger] = await ethers.getSigners();

    consolidationGateway = ctx.contracts.consolidationGateway;

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  it("Should revert when non-authorized user tries to trigger consolidation", async () => {
    const sourcePubkeys = [sourcePubkey1];
    const targetPubkeys = [targetPubkey1];
    const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();

    await expect(
      consolidationGateway
        .connect(stranger)
        .triggerConsolidation(sourcePubkeys, targetPubkeys, stranger.address, { value: 1n }),
    ).to.be.revertedWithOZAccessControlError(stranger.address, role);
  });

  it("Should successfully trigger consolidation requests", async () => {
    const { withdrawalVault } = ctx.contracts;
    const agentSigner = await ctx.getSigner("agent");

    await consolidationGateway
      .connect(agentSigner)
      .grantRole(await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE(), requestor.address);

    const sourcePubkeys = [sourcePubkey1, sourcePubkey2];
    const targetPubkeys = [targetPubkey1, targetPubkey2];
    const fee = await withdrawalVault.getConsolidationRequestFee();
    const totalFee = fee * BigInt(sourcePubkeys.length);

    const initialLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
      .currentConsolidationRequestsLimit;

    const tx = await consolidationGateway
      .connect(requestor)
      .triggerConsolidation(sourcePubkeys, targetPubkeys, requestor.address, {
        value: totalFee,
      });

    const receipt = await tx.wait();
    expect(receipt).not.to.be.null;

    const finalLimit = (await consolidationGateway.getConsolidationRequestLimitFullInfo())
      .currentConsolidationRequestsLimit;
    expect(finalLimit).to.equal(initialLimit - BigInt(sourcePubkeys.length));

    // Verify ConsolidationRequestAdded events were emitted by WithdrawalVault
    const consolidationEvents = findEventsWithInterfaces(receipt!, "ConsolidationRequestAdded", [
      withdrawalVault.interface,
    ]);
    expect(consolidationEvents?.length).to.equal(sourcePubkeys.length);

    // Verify each event contains the correct request data
    consolidationEvents?.forEach((event, i) => {
      const requestData = event.args.request;
      const expectedRequest = sourcePubkeys[i] + targetPubkeys[i].slice(2); // Remove 0x from target
      expect(requestData).to.equal(expectedRequest);
    });
  });
});
