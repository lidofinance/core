import { ContractTransactionReceipt } from "ethers";
import { ethers } from "hardhat";

import { findEventsWithInterfaces } from "lib";

const withdrawalRequestEventABI = ["event WithdrawalRequestAdded(bytes pubkey, uint256 amount)"];
const withdrawalRequestEventInterface = new ethers.Interface(withdrawalRequestEventABI);
type WithdrawalRequestEvents = "WithdrawalRequestAdded";

export function findEvents(receipt: ContractTransactionReceipt, event: WithdrawalRequestEvents) {
  return findEventsWithInterfaces(receipt!, event, [withdrawalRequestEventInterface]);
}

const eip7002TriggerableWithdrawalMockEventABI = ["event eip7002WithdrawalRequestAdded(bytes request, uint256 fee)"];
const eip7002TriggerableWithdrawalMockInterface = new ethers.Interface(eip7002TriggerableWithdrawalMockEventABI);
type Eip7002WithdrawalEvents = "eip7002WithdrawalRequestAdded";

export function findEip7002TriggerableWithdrawalMockEvents(
  receipt: ContractTransactionReceipt,
  event: Eip7002WithdrawalEvents,
) {
  return findEventsWithInterfaces(receipt!, event, [eip7002TriggerableWithdrawalMockInterface]);
}
