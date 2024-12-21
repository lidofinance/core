import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const withdrawalRequestEventABI = ["event WithdrawalRequestAdded(bytes pubkey, uint256 amount)"];
const withdrawalRequestEventInterface = new ethers.Interface(withdrawalRequestEventABI);

type WithdrawalRequestEvents = "WithdrawalRequestAdded";

export function findEvents(receipt: ContractTransactionReceipt, event: WithdrawalRequestEvents) {
  return findEventsWithInterfaces(receipt!, event, [withdrawalRequestEventInterface]);
}
