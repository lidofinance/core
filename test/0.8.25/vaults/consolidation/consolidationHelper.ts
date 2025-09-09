import { BytesLike } from "ethers";

import { SecretKey } from "@chainsafe/blst";

import { ether } from "lib";

export function generateConsolidationRequestPayload(numberOfRequests: number): {
  sourcePubkeys: BytesLike[];
  targetPubkeys: BytesLike[];
  totalSourcePubkeysCount: number;
  adjustmentIncrease: bigint;
} {
  const sourcePubkeys: BytesLike[] = [];
  const targetPubkeys: BytesLike[] = [];
  let adjustmentIncrease: bigint = 0n;
  let totalSourcePubkeysCount = 0;
  const numberOfSourcePubkeysMax = 50;
  for (let i = 1; i <= numberOfRequests; i++) {
    let tempSourcePubkeys: Uint8Array = new Uint8Array();
    const numberOfSourcePubkeys = Math.floor(Math.random() * numberOfSourcePubkeysMax) + 1;
    totalSourcePubkeysCount += numberOfSourcePubkeys;
    for (let j = 1; j <= numberOfSourcePubkeys; j++) {
      const publicKey = generateRandomPublicKey(i * j);
      tempSourcePubkeys = concatUint8Arrays([tempSourcePubkeys, publicKey]);
      adjustmentIncrease += ether("17");
    }
    sourcePubkeys.push(tempSourcePubkeys);
    const publicKey = generateRandomPublicKey(i * numberOfSourcePubkeys + 1);
    targetPubkeys.push(publicKey);
  }

  return {
    sourcePubkeys,
    targetPubkeys,
    totalSourcePubkeysCount,
    adjustmentIncrease,
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

function generateRandomPublicKey(index: number): Uint8Array {
  const ikm = Uint8Array.from(Buffer.from("test test test test test test test", "utf-8"));
  const masterSecret = SecretKey.deriveMasterEip2333(ikm);
  const sk = masterSecret.deriveChildEip2333(index);
  return sk.toPublicKey().toBytes();
}
