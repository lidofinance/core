import { BigNumberish, hexlify, randomBytes } from "ethers";

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

/***
 * Returns a hexadecimal representation of the given numbers
 * @param {BigNumberish} n number to represent in hex
 * @param {number} byteLen bytes to pad
 * @returns {string} hexadecimal string
 */
export function numberToHex(n: BigNumberish, byteLen: number | undefined = undefined): string {
  const s = n.toString(16);
  return byteLen === undefined ? s : s.padStart(byteLen * 2, "0");
}
