import { expect } from "chai";
import { BytesLike, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const eventName = "ConsolidationRequestAdded__Mock";
const eip7251MockEventABI = [`event ${eventName}(bytes request, address sender, uint256 fee)`];
const eip7251MockInterface = new ethers.Interface(eip7251MockEventABI);
const KEY_LENGTH = 48;

export function findEIP7251MockEvents(receipt: ContractTransactionReceipt) {
  return findEventsWithInterfaces(receipt!, eventName, [eip7251MockInterface]);
}

const dashboardMockEventName = "RewardsAdjustmentIncreased";
const dashboardMockEventABI = [`event ${dashboardMockEventName}(uint256 _amount)`];
const dashboardMockInterface = new ethers.Interface(dashboardMockEventABI);

export function findDashboardMockEvents(receipt: ContractTransactionReceipt) {
  return findEventsWithInterfaces(receipt!, dashboardMockEventName, [dashboardMockInterface]);
}

export const testEIP7251Mock = async (
  addConsolidationRequests: () => Promise<ContractTransactionResponse>,
  sender: string,
  expectedSourcePubkeys: BytesLike[],
  expectedTargetPubkeys: BytesLike[],
  expectedFee: bigint,
): Promise<{ tx: ContractTransactionResponse; receipt: ContractTransactionReceipt }> => {
  const tx = await addConsolidationRequests();
  const receipt = (await tx.wait()) as ContractTransactionReceipt;

  const totalPubkeysCount = expectedSourcePubkeys.reduce(
    (acc, pubkeys) => acc + BigInt(Math.floor(pubkeys.length / KEY_LENGTH)),
    0n,
  );
  const events = findEIP7251MockEvents(receipt);
  expect(events.length).to.equal(totalPubkeysCount);

  for (let i = 0; i < expectedSourcePubkeys.length; i++) {
    const pubkeysCount = Math.floor(expectedSourcePubkeys[i].length / KEY_LENGTH);
    for (let j = 0; j < pubkeysCount; j++) {
      const expectedSourcePubkey = expectedSourcePubkeys[i].slice(j * KEY_LENGTH, (j + 1) * KEY_LENGTH);
      const result = ethers.concat([expectedSourcePubkey, expectedTargetPubkeys[i]]);
      expect(events[i * pubkeysCount + j].args[0]).to.equal(result);
      expect(events[i * pubkeysCount + j].args[1]).to.equal(sender);
      expect(events[i * pubkeysCount + j].args[2]).to.equal(expectedFee);
    }
  }

  return { tx, receipt };
};
