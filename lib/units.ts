import { BigNumberish, parseEther as ether, parseUnits } from "ethers";

export const ONE_ETHER = ether("1.0");

const shares = (value: bigint) => parseUnits(value.toString(), "ether");

const shareRate = (value: bigint) => parseUnits(value.toString(), 27);

const toGwei = (value: BigNumberish) => BigInt(value) / 1_000_000_000n;

export { ether, shares, shareRate, toGwei };
