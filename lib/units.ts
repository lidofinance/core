import { BytesLike, parseEther as ether, parseUnits } from "ethers";

export const ONE_ETHER = ether("1.0");

function gwei(value: string) {
  return parseUnits(value, 9);
}

function etherToGweiBytes(etherValue: string, bytes: number): string {
  return "0x" + (ether(etherValue) / gwei("1")).toString(16).padStart(bytes * 2, "0");
}

const shares = (value: bigint) => parseUnits(value.toString(), "ether");

const shareRate = (value: bigint) => parseUnits(value.toString(), 27);

export { ether, etherToGweiBytes, gwei, shares, shareRate };
