import {
  bufferToHex,
  ECDSASignature,
  ecrecover,
  ecsign,
  pubToAddress,
  toBuffer,
  toChecksumAddress,
} from "ethereumjs-util";

import { de0x } from "./string.js";

export function sign(message: string, privateKey: string) {
  return ecsign(Buffer.from(de0x(message), "hex"), Buffer.from(de0x(privateKey), "hex"));
}

export function recover(messageHash: string, { v, r, s }: ECDSASignature) {
  const pubKey = ecrecover(Buffer.from(de0x(messageHash), "hex"), v, Buffer.from(r), Buffer.from(s));
  return toChecksumAddress(bufferToHex(pubToAddress(pubKey)));
}

// Converts a ECDSA signature to the format provided in https://eips.ethereum.org/EIPS/eip-2098.
export function toEip2098({ v, r, s }: ECDSASignature) {
  const vs = toBuffer(s);
  if (vs[0] >> 7 === 1) {
    throw new Error(`invalid signature 's' value`);
  }
  vs[0] |= v % 27 << 7; // set the first bit of vs to the v parity bit
  return { r, vs: bufferToHex(vs) };
}
