import { ethers } from "hardhat";

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
    pubkeysHexArray: pubkeys.map((pk) => `0x${pk}`),
    pubkeys,
    fullWithdrawalAmounts,
    partialWithdrawalAmounts,
    mixedWithdrawalAmounts,
  };
}
