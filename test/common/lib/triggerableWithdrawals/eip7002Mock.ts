import { expect } from "chai";
import { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const eip7002MockEventABI = ["event eip7002MockRequestAdded(bytes request, uint256 fee)"];
const eip7002MockInterface = new ethers.Interface(eip7002MockEventABI);
type Eip7002MockTriggerableWithdrawalEvents = "eip7002MockRequestAdded";

export function findEip7002MockEvents(
  receipt: ContractTransactionReceipt,
  event: Eip7002MockTriggerableWithdrawalEvents,
) {
  return findEventsWithInterfaces(receipt!, event, [eip7002MockInterface]);
}

export function encodeEip7002Payload(pubkey: string, amount: bigint): string {
  return `0x${pubkey}${amount.toString(16).padStart(16, "0")}`;
}

export const testEip7002Mock = async (
  addTriggeranleWithdrawalRequests: () => Promise<ContractTransactionResponse>,
  expectedPubkeys: string[],
  expectedAmounts: bigint[],
  expectedFee: bigint,
): Promise<{ tx: ContractTransactionResponse; receipt: ContractTransactionReceipt }> => {
  const tx = await addTriggeranleWithdrawalRequests();
  const receipt = await tx.wait();

  const events = findEip7002MockEvents(receipt!, "eip7002MockRequestAdded");
  expect(events.length).to.equal(expectedPubkeys.length);

  for (let i = 0; i < expectedPubkeys.length; i++) {
    expect(events[i].args[0]).to.equal(encodeEip7002Payload(expectedPubkeys[i], expectedAmounts[i]));
    expect(events[i].args[1]).to.equal(expectedFee);
  }

  if (!receipt) {
    throw new Error("No receipt");
  }

  return { tx, receipt };
};
