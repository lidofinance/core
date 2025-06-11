import { BytesLike } from "ethers";

import { SecretKey } from "@chainsafe/blst";

export function generateConsolidationRequestPayload(numberOfRequests: number): {
  sourcePubkeys: BytesLike[];
  targetPubkeys: BytesLike[];
  totalSourcePubkeysCount: number;
  adjustmentIncreases: bigint[];
} {
  const sourcePubkeys: BytesLike[] = [];
  const targetPubkeys: BytesLike[] = [];
  const adjustmentIncreases: bigint[] = [];
  let totalSourcePubkeysCount = 0;
  const numberOfSourcePubkeys = 50;
  for (let i = 1; i <= numberOfRequests; i++) {
    let tempSourcePubkeys: Uint8Array = new Uint8Array();
    totalSourcePubkeysCount += numberOfSourcePubkeys;
    for (let j = 1; j <= numberOfSourcePubkeys; j++) {
      const publicKey = generateRandomPublicKey(i * j);
      tempSourcePubkeys = concatUint8Arrays([tempSourcePubkeys, publicKey]);
    }
    sourcePubkeys.push(tempSourcePubkeys);
    const publicKey = generateRandomPublicKey(i * numberOfSourcePubkeys + 1);
    targetPubkeys.push(publicKey);
    adjustmentIncreases.push(32n);
  }

  return {
    sourcePubkeys,
    targetPubkeys,
    totalSourcePubkeysCount,
    adjustmentIncreases,
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
