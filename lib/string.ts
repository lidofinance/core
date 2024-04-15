import assert from "node:assert";

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

export function hexSplit(hexStr: string, lenBytes: number) {
  const lenSymbols = lenBytes * 2;
  hexStr = de0x(hexStr);
  assert(hexStr.length % lenSymbols === 0, `data length must be a multiple of ${lenBytes} bytes`);

  return Array.from(
    { length: hexStr.length / lenSymbols },
    (_, i) => "0x" + hexStr.substring(i * lenSymbols, (i + 1) * lenSymbols),
  );
}
