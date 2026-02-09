import { AddressLike, resolveAddress } from "ethers";

import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import { streccak } from "lib";

const MASK_128_BITS = (1n << 128n) - 1n;

export type Uint128Pair = {
  low: bigint;
  high: bigint;
};

/**
 * @dev Get the storage at a given position for a given contract
 * @param contract - The contract to get the storage at
 * @param positionTag - The tag of the position to get the storage at
 * @returns The storage at the given position
 */
export async function getStorageAtPosition(contract: AddressLike, positionTag: string): Promise<string> {
  return getStorageAt(await resolveAddress(contract), streccak(positionTag));
}

/**
 * @dev Splits a uint256 slot value into low/high uint128 parts.
 * @param value - Raw value returned by getStorageAtPosition (hex string or bigint)
 * @returns Parsed low and high 128-bit values
 */
export function splitStorageUint256ToUint128Pair(value: string | bigint): Uint128Pair {
  const rawValue = typeof value === "bigint" ? value : BigInt(value);
  return {
    low: rawValue & MASK_128_BITS,
    high: rawValue >> 128n,
  };
}

/**
 * @dev Reads storage at a tagged position and returns low/high uint128 parts.
 * @param contract - The contract to read storage from
 * @param positionTag - The tag of the position to read
 * @returns Parsed low and high 128-bit values
 */
export async function getStorageAtPositionAsUint128Pair(
  contract: AddressLike,
  positionTag: string,
): Promise<Uint128Pair> {
  return splitStorageUint256ToUint128Pair(await getStorageAtPosition(contract, positionTag));
}
