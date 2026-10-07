import { bufferToHex, ECDSASignature, ecrecover, ecsign, pubToAddress, toChecksumAddress } from "ethereumjs-util";

import { de0x } from "./string";

export function sign(message: string, privateKey: string) {
  return ecsign(Buffer.from(de0x(message), "hex"), Buffer.from(de0x(privateKey), "hex"));
}

export function recover(messageHash: string, { v, r, s }: ECDSASignature) {
  const pubKey = ecrecover(Buffer.from(de0x(messageHash), "hex"), v, Buffer.from(r), Buffer.from(s));
  return toChecksumAddress(bufferToHex(pubToAddress(pubKey)));
}
