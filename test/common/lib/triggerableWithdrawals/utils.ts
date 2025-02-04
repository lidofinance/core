import { ethers } from "hardhat";

import { EIP7002WithdrawalRequest_Mock } from "typechain-types";

export const withdrawalsPredeployedHardcodedAddress = "0x00000961Ef480Eb55e80D19ad83579A64c007002";

export async function deployWithdrawalsPredeployedMock(
  defaultRequestFee: bigint,
): Promise<EIP7002WithdrawalRequest_Mock> {
  const withdrawalsPredeployed = await ethers.deployContract("EIP7002WithdrawalRequest_Mock");
  const withdrawalsPredeployedAddress = await withdrawalsPredeployed.getAddress();

  await ethers.provider.send("hardhat_setCode", [
    withdrawalsPredeployedHardcodedAddress,
    await ethers.provider.getCode(withdrawalsPredeployedAddress),
  ]);

  const contract = await ethers.getContractAt("EIP7002WithdrawalRequest_Mock", withdrawalsPredeployedHardcodedAddress);
  await contract.setFee(defaultRequestFee);
  return contract;
}

function toValidatorPubKey(num: number): string {
  if (num < 0 || num > 0xffff) {
    throw new Error("Number is out of the 2-byte range (0x0000 - 0xffff).");
  }

  return `${num.toString(16).padStart(4, "0").toLocaleLowerCase().repeat(24)}`;
}

const convertEthToGwei = (ethAmount: string | number): bigint => {
  const ethString = ethAmount.toString();
  const wei = ethers.parseEther(ethString);
  return wei / 1_000_000_000n;
};

export function generateWithdrawalRequestPayload(numberOfRequests: number) {
  const pubkeys: string[] = [];
  const fullWithdrawalAmounts: bigint[] = [];
  const partialWithdrawalAmounts: bigint[] = [];
  const mixedWithdrawalAmounts: bigint[] = [];

  for (let i = 1; i <= numberOfRequests; i++) {
    pubkeys.push(toValidatorPubKey(i));
    fullWithdrawalAmounts.push(0n);
    partialWithdrawalAmounts.push(convertEthToGwei(i));
    mixedWithdrawalAmounts.push(i % 2 === 0 ? 0n : convertEthToGwei(i));
  }

  return {
    pubkeysHexString: `0x${pubkeys.join("")}`,
    pubkeys,
    fullWithdrawalAmounts,
    partialWithdrawalAmounts,
    mixedWithdrawalAmounts,
  };
}
