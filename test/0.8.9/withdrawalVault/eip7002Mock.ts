import { expect } from "chai";
import { ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import { ethers } from "hardhat";

import { EIP7002WithdrawalRequest__Mock } from "typechain-types";

import { EIP7002_ADDRESS, findEventsWithInterfaces } from "lib";

const eventName = "RequestAdded__Mock";
const eip7002MockEventABI = [`event ${eventName}(bytes request, uint256 fee)`];
const eip7002MockInterface = new ethers.Interface(eip7002MockEventABI);

export const deployEIP7002WithdrawalRequestContractMock = async (
  fee: bigint,
): Promise<EIP7002WithdrawalRequest__Mock> => {
  const eip7002Mock = await ethers.deployContract("EIP7002WithdrawalRequest__Mock");
  const eip7002MockAddress = await eip7002Mock.getAddress();

  await ethers.provider.send("hardhat_setCode", [EIP7002_ADDRESS, await ethers.provider.getCode(eip7002MockAddress)]);

  const contract = await ethers.getContractAt("EIP7002WithdrawalRequest__Mock", EIP7002_ADDRESS);
  await contract.mock__setFee(fee);

  return contract;
};

export function encodeEIP7002Payload(pubkey: string, amount: bigint): string {
  // remove 0x prefix if it exists
  const pubkeyWithoutPrefix = pubkey.startsWith("0x") ? pubkey.slice(2) : pubkey;
  return `0x${pubkeyWithoutPrefix}${amount.toString(16).padStart(16, "0")}`;
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
