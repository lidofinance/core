import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { deployLidoLocator } from "./locator";

/** Default exit balance limit of the gateway in tests: max in ETH, restored ETH per frame, frame duration in seconds. */
export const DEFAULT_TWG_LIMIT = { maxExitBalanceEth: 10_000n, balancePerFrameEth: 32n, frameDurationInSec: 1_000n };

/** Deploys TriggerableWithdrawalsGateway with a WithdrawalVault mock registered in a dummy locator. */
export async function deployTriggerableWithdrawalsGateway(admin: HardhatEthersSigner, limit = DEFAULT_TWG_LIMIT) {
  const withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForTriggerableWithdrawalsGateway");
  const locator = await deployLidoLocator({ withdrawalVault: await withdrawalVault.getAddress() });

  const gateway = await ethers.deployContract("TriggerableWithdrawalsGateway", [
    admin.address,
    await locator.getAddress(),
    limit.maxExitBalanceEth,
    limit.balancePerFrameEth,
    limit.frameDurationInSec,
  ]);

  return { gateway, withdrawalVault, locator };
}
