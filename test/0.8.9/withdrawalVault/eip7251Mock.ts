import { expect } from "chai";
import { ContractTransactionReceipt, ContractTransactionResponse, Interface } from "ethers";
import hre from "hardhat";

import { type EIP7251ConsolidationRequest__Mock } from "typechain-types/index.js";

import { EIP7251_ADDRESS, findEventsWithInterfaces } from "lib/index.js";

const eventName = "ConsolidationRequestAdded__Mock";
const eip7251MockEventABI = [`event ${eventName}(bytes request, uint256 fee)`];
const eip7251MockInterface = new Interface(eip7251MockEventABI);

export const deployEIP7251ConsolidationRequestContractMock = async (
  fee: bigint,
): Promise<EIP7251ConsolidationRequest__Mock> => {
  const { ethers } = await hre.network.getOrCreate();
  const eip7251Mock = await ethers.deployContract("EIP7251ConsolidationRequest__Mock");
  const eip7251MockAddress = await eip7251Mock.getAddress();

  await ethers.provider.send("hardhat_setCode", [EIP7251_ADDRESS, await ethers.provider.getCode(eip7251MockAddress)]);

  const contract = await ethers.getContractAt("EIP7251ConsolidationRequest__Mock", EIP7251_ADDRESS);
  await contract.mock__setFee(fee);

  return contract;
};

export const encodeEIP7251Payload = (sourcePubkey: string, targetPubkey: string): string => {
  const sourcePubkeyHex = sourcePubkey.startsWith("0x") ? sourcePubkey.slice(2) : sourcePubkey;
  const targetPubkeyHex = targetPubkey.startsWith("0x") ? targetPubkey.slice(2) : targetPubkey;
  return `0x${sourcePubkeyHex}${targetPubkeyHex}`;
};

export function findEIP7251MockEvents(receipt: ContractTransactionReceipt) {
  return findEventsWithInterfaces(receipt!, eventName, [eip7251MockInterface]);
}

export const testEIP7251Mock = async (
  addConsolidationRequests: () => Promise<ContractTransactionResponse>,
  sourcePubkeys: string[],
  targetPubkeys: string[],
  expectedFee: bigint,
): Promise<{ tx: ContractTransactionResponse; receipt: ContractTransactionReceipt }> => {
  const tx = await addConsolidationRequests();
  const receipt = (await tx.wait()) as ContractTransactionReceipt;

  const events = findEIP7251MockEvents(receipt);
  expect(events.length).to.equal(sourcePubkeys.length);

  for (let i = 0; i < sourcePubkeys.length; i++) {
    expect(events[i].args[0]).to.equal(encodeEIP7251Payload(sourcePubkeys[i], targetPubkeys[i]));
    expect(events[i].args[1]).to.equal(expectedFee);
  }

  return { tx, receipt };
};
