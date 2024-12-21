import { ethers } from "hardhat";

import { WithdrawalsPredeployed_Mock } from "typechain-types";

export const withdrawalsPredeployedHardcodedAddress = "0x0c15F14308530b7CDB8460094BbB9cC28b9AaaAA";

export async function deployWithdrawalsPredeployedMock(
  defaultRequestFee: bigint,
): Promise<WithdrawalsPredeployed_Mock> {
  const withdrawalsPredeployed = await ethers.deployContract("WithdrawalsPredeployed_Mock");
  const withdrawalsPredeployedAddress = await withdrawalsPredeployed.getAddress();

  await ethers.provider.send("hardhat_setCode", [
    withdrawalsPredeployedHardcodedAddress,
    await ethers.provider.getCode(withdrawalsPredeployedAddress),
  ]);

  const contract = await ethers.getContractAt("WithdrawalsPredeployed_Mock", withdrawalsPredeployedHardcodedAddress);
  await contract.setFee(defaultRequestFee);
  return contract;
}

function toValidatorPubKey(num: number): string {
  if (num < 0 || num > 0xffff) {
    throw new Error("Number is out of the 2-byte range (0x0000 - 0xFFFF).");
  }

  return `0x${num.toString(16).padStart(4, "0").repeat(24)}`;
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

  return { pubkeys, fullWithdrawalAmounts, partialWithdrawalAmounts, mixedWithdrawalAmounts };
}
