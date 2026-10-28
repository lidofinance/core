import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { deployLidoLocator } from "./locator";

/** Deploys TriggerableWithdrawalsGateway with a WithdrawalVault mock registered in a dummy locator. */
export async function deployTriggerableWithdrawalsGateway(admin: HardhatEthersSigner) {
  const withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForTriggerableWithdrawalsGateway");
  const locator = await deployLidoLocator({ withdrawalVault: await withdrawalVault.getAddress() });

  const gateway = await ethers.deployContract("TriggerableWithdrawalsGateway", [
    admin.address,
    await locator.getAddress(),
  ]);

  return { gateway, withdrawalVault, locator };
}
