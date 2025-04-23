import { expect } from "chai";
import { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const eventName = "RequestAdded__Mock";
const eip7002MockEventABI = [`event ${eventName}(bytes request, uint256 fee)`];
const eip7002MockInterface = new ethers.Interface(eip7002MockEventABI);

function encodeEIP7002Payload(pubkey: string, amount: bigint): string {
  return `0x${pubkey}${amount.toString(16).padStart(16, "0")}`;
}

export function findEIP7002MockEvents(receipt: ContractTransactionReceipt) {
  return findEventsWithInterfaces(receipt!, eventName, [eip7002MockInterface]);
}

export const testEIP7002Mock = async (
  addTriggerableWithdrawalRequests: () => Promise<ContractTransactionResponse>,
  expectedPubkeys: string[],
  expectedAmounts: bigint[],
  expectedFee: bigint,
): Promise<{ tx: ContractTransactionResponse; receipt: ContractTransactionReceipt }> => {
  const tx = await addTriggerableWithdrawalRequests();
  const receipt = (await tx.wait()) as ContractTransactionReceipt;

  const events = findEIP7002MockEvents(receipt);
  expect(events.length).to.equal(expectedPubkeys.length);

  for (let i = 0; i < expectedPubkeys.length; i++) {
    expect(events[i].args[0]).to.equal(encodeEIP7002Payload(expectedPubkeys[i], expectedAmounts[i]));
    expect(events[i].args[1]).to.equal(expectedFee);
  }

  return { tx, receipt };
};
