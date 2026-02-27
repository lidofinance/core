import { type AddressLike, resolveAddress } from "ethers";

import { networkHelpers } from "./hardhat.js";
import { streccak } from "./keccak.js";

/**
 * @dev Get the storage at a given position for a given contract
 * @param contract - The contract to get the storage at
 * @param positionTag - The tag of the position to get the storage at
 * @returns The storage at the given position
 */
export async function getStorageAtPosition(contract: AddressLike, positionTag: string): Promise<string> {
  return networkHelpers.getStorageAt(await resolveAddress(contract), streccak(positionTag));
}
