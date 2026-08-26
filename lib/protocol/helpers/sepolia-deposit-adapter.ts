import { ethers } from "hardhat";

import { ether, impersonate, log } from "lib";
import { SEPOLIA_BEPOLIA_WHALE, SEPOLIA_CHAIN_ID, SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT } from "lib/protocol/sepolia";

import { ProtocolContext } from "../types";

// BEPOLIA is both the token and the Sepolia beacon deposit contract: each deposit() burns one.
// `provision()` triggers ~100 deposits, so top up the adapter well above that.
const BEPOLIA_ADAPTER_TOPUP = 100_000n;

export const ensureSepoliaDepositAdapterFunded = async (ctx: ProtocolContext) => {
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== BigInt(SEPOLIA_CHAIN_ID)) return;

  const [adapterAddress, bepolia] = await Promise.all([
    ctx.contracts.stakingRouter.DEPOSIT_CONTRACT(),
    ethers.getContractAt("ISepoliaDepositContract", SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT),
  ]);

  const balance = await bepolia.balanceOf(adapterAddress);
  if (balance >= BEPOLIA_ADAPTER_TOPUP) return;

  const whale = await impersonate(SEPOLIA_BEPOLIA_WHALE, ether("1"));
  await bepolia.connect(whale).transfer(adapterAddress, BEPOLIA_ADAPTER_TOPUP);

  log.success(`Funded Sepolia deposit adapter ${adapterAddress} with ${BEPOLIA_ADAPTER_TOPUP} BEPOLIA`);
};
