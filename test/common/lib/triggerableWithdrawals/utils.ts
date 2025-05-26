import { BytesLike } from "ethers";
import { ethers } from "hardhat";

import { getPublicKey,utils } from "@noble/bls12-381";

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

export function generateConsolidationRequestPayload(numberOfRequests: number): {
  sourcePubkeys: BytesLike[];
  targetPubkeys: BytesLike[];
  totalSourcePubkeysCount: number;
} {
  const sourcePubkeys: BytesLike[] = [];
  const targetPubkeys: BytesLike[] = [];
  let totalSourcePubkeysCount = 0;
  const numberOfSourcePubkeys = 50;
  for (let i = 1; i <= numberOfRequests; i++) {
    let tempSourcePubkeys: Uint8Array = new Uint8Array();
    totalSourcePubkeysCount += numberOfSourcePubkeys;
    for (let j = 1; j <= numberOfSourcePubkeys; j++) {
      const privateKey = utils.randomPrivateKey();
      const publicKey = getPublicKey(privateKey);
      tempSourcePubkeys = concatUint8Arrays([tempSourcePubkeys, publicKey]);
    }
    sourcePubkeys.push(tempSourcePubkeys);
    const privateKey = utils.randomPrivateKey();
    const publicKey = getPublicKey(privateKey);
    targetPubkeys.push(publicKey);
  }

  return {
    sourcePubkeys,
    targetPubkeys,
    totalSourcePubkeysCount,
  };
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, curr) => acc + curr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}
