import { expect } from "chai";
import { BytesLike, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const eventName = "RequestAdded__Mock";
const eip7251MockEventABI = [`event ${eventName}(bytes request, uint256 fee)`];
const eip7251MockInterface = new ethers.Interface(eip7251MockEventABI);

export function findEIP7251MockEvents(receipt: ContractTransactionReceipt) {
  return findEventsWithInterfaces(receipt!, eventName, [eip7251MockInterface]);
}

export const testEIP7251Mock = async (
  addConsolidationRequests: () => Promise<ContractTransactionResponse>,
  expectedSourcePubkeys: BytesLike[],
  expectedTargetPubkeys: BytesLike[],
  expectedFee: bigint,
): Promise<{ tx: ContractTransactionResponse; receipt: ContractTransactionReceipt }> => {
  const tx = await addConsolidationRequests();
  const receipt = (await tx.wait()) as ContractTransactionReceipt;

  const keyLength = 48;
  const totalPubkeysCount = expectedSourcePubkeys.reduce(
    (acc, pubkeys) => acc + BigInt(Math.floor(pubkeys.length / keyLength)),
    0n,
  );
  const events = findEIP7251MockEvents(receipt);
  expect(events.length).to.equal(totalPubkeysCount);

  for (let i = 0; i < expectedSourcePubkeys.length; i++) {
    const pubkeysCount = Math.floor(expectedSourcePubkeys[i].length / keyLength);
    for (let j = 0; j < pubkeysCount; j++) {
      const expectedSourcePubkey = expectedSourcePubkeys[i].slice(j * keyLength, (j + 1) * keyLength);
      const result = ethers.concat([expectedSourcePubkey, expectedTargetPubkeys[i]]);
      expect(events[i * pubkeysCount + j].args[0]).to.equal(result);
      expect(events[i * pubkeysCount + j].args[1]).to.equal(expectedFee);
    }
  }

  return { tx, receipt };
};
