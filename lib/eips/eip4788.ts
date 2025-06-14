import { ethers } from "hardhat";

import { impersonate } from "lib";

// Address of the Beacon Block Storage contract, which exposes beacon chain roots.
// This corresponds to `BEACON_ROOTS_ADDRESS` as specified in EIP-4788.
export const BEACON_ROOTS_ADDRESS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";

export const updateBeaconBlockRoot = async (root: string): Promise<number> => {
  const beaconRootUpdater = await impersonate(
    "0xfffffffffffffffffffffffffffffffffffffffe",
    999999999999999999999999999n,
  );

  const transaction = await beaconRootUpdater.sendTransaction({
    to: BEACON_ROOTS_ADDRESS,
    value: 0,
    data: root,
  });

  const blockDetails = await transaction.getBlock();
  if (!blockDetails) throw new Error("Failed to retrieve block details.");

  return blockDetails.timestamp;
};

export const ensureEIP4788BeaconBlockRootContractPresent = async (): Promise<void> => {
  const code = await ethers.provider.getCode(BEACON_ROOTS_ADDRESS);

  if (code === "0x") {
    throw new Error(`EIP7788 Beacon Block Root contract not found at ${BEACON_ROOTS_ADDRESS}`);
  }
};
