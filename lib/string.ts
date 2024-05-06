import { bigintToHex } from "bigint-conversion";
import { hexlify, randomBytes } from "ethers";

export function de0x(hex: string) {
  return hex.startsWith("0x") ? hex.slice(2) : hex;
}

export function en0x(value: number | bigint) {
  const hexValue = value.toString(16);
  const prefix = hexValue.length % 2 ? "0x0" : "0x";
  return prefix + hexValue;
}

export function randomString(length: number) {
  return hexlify(randomBytes(length));
}

export function numberToHex(n: number, byteLen: number | undefined = undefined) {
  return bigintToHex(BigInt(n), false, byteLen);
}
