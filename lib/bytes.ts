import { bigintToHex } from "bigint-conversion";
import { BigNumberish, BytesLike } from "ethers";

export function toLittleEndian64(value: BigNumberish): BytesLike {
  const bytes = bigintToHex(BigInt(value), false, 8);
  return "0x" + Buffer.from(bytes, "hex").reverse().toString("hex");
}
