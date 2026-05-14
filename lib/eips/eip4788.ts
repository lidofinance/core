import { ethers } from "hardhat";

import { impersonate, log } from "lib";

// Address of the Beacon Block Storage contract, which exposes beacon chain roots.
// This corresponds to `BEACON_ROOTS_ADDRESS` as specified in EIP-4788.
export const BEACON_ROOTS_ADDRESS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";

const EIP4788_RUNTIME_BYTECODE =
  "0x3373fffffffffffffffffffffffffffffffffffffffe14604d57602036146024575f5ffd5b5f35801560495762001fff810690815414603c575f5ffd5b62001fff01545f5260205ff35b5f5ffd5b62001fff42064281555f359062001fff015500";

export const deployEIP4788BeaconBlockRootContract = async (): Promise<void> => {
  await ethers.provider.send("hardhat_setCode", [BEACON_ROOTS_ADDRESS, EIP4788_RUNTIME_BYTECODE]);
};

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
    log.warning(`EIP4788 Beacon Block Root contract not found at ${BEACON_ROOTS_ADDRESS}`);

    await deployEIP4788BeaconBlockRootContract();
    log.success("EIP4788 Beacon Block Root contract is present");
  }
};
