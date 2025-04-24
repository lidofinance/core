import { expect } from "chai";
import { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const eventName = "RequestAdded__Mock";
const eip7251MockEventABI = [`event ${eventName}(bytes request, uint256 fee)`];
const eip7251MockInterface = new ethers.Interface(eip7251MockEventABI);

export function encodeEIP7251Payload(sourcePubkey: string, targetPubkey: string): string {
  return `0x${sourcePubkey}${targetPubkey}`;
}

export function findEIP7251MockEvents(receipt: ContractTransactionReceipt) {
  return findEventsWithInterfaces(receipt!, eventName, [eip7251MockInterface]);
}

export const testEIP7251Mock = async (
  addTriggerableWithdrawalRequests: () => Promise<ContractTransactionResponse>,
  expectedSourcePubkeys: string[],
  expectedTargetPubkeys: string[],
  expectedFee: bigint,
): Promise<{ tx: ContractTransactionResponse; receipt: ContractTransactionReceipt }> => {
  const tx = await addTriggerableWithdrawalRequests();
  const receipt = (await tx.wait()) as ContractTransactionReceipt;

  const events = findEIP7251MockEvents(receipt);
  expect(events.length).to.equal(expectedSourcePubkeys.length);

  for (let i = 0; i < expectedSourcePubkeys.length; i++) {
    expect(events[i].args[0]).to.equal(encodeEIP7251Payload(expectedSourcePubkeys[i], expectedTargetPubkeys[i]));
    expect(events[i].args[1]).to.equal(expectedFee);
  }

  return { tx, receipt };
};
