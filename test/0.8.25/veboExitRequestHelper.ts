import { expect } from "chai";
import { ContractTransactionReceipt, ethers } from "ethers";

import { de0x, findEventsWithInterfaces, numberToHex } from "lib";

export interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  valPubkey: string;
}

export const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
  const pubkeyHex = de0x(valPubkey);
  expect(pubkeyHex.length).to.equal(48 * 2);
  return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
};

export const encodeExitRequestsDataList = (requests: ExitRequest[]) => {
  return "0x" + requests.map(encodeExitRequestHex).join("");
};

const stakingRouterMockEventABI = [
  "event UnexitedValidatorReported(uint256 moduleId, uint256 nodeOperatorId, bytes publicKey, uint256 secondsSinceEligibleExitRequest)",
];
const stakingRouterMockInterface = new ethers.Interface(stakingRouterMockEventABI);
type StakingRouterMockEvents = "UnexitedValidatorReported";

export function findStakingRouterMockEvents(receipt: ContractTransactionReceipt, event: StakingRouterMockEvents) {
  return findEventsWithInterfaces(receipt!, event, [stakingRouterMockInterface]);
}

// export function calculateEarliestPossibleVoluntaryExitTimestamp(
//   validatorActivationEpoch: number,
//   genesisTime: number,
//   slotsPerEpoch: number,
//   secondsPerSlot: number,
//   shardCommitteePeriodInSeconds: number,
// ) {
//   return genesisTime + validatorActivationEpoch * slotsPerEpoch * secondsPerSlot + shardCommitteePeriodInSeconds;
// }

// export function calculateSecondsSinceEligibleExitRequest(
//   validatorExitRequestTimestamp: number,
//   referenceTimestamp: number,
//   earliestPossibleVoluntaryExitTimestamp: number,
// ) {
//   const eligibleExitRequestTimestamp =
//     validatorExitRequestTimestamp > earliestPossibleVoluntaryExitTimestamp
//       ? validatorExitRequestTimestamp
//       : earliestPossibleVoluntaryExitTimestamp;

//   return referenceTimestamp - eligibleExitRequestTimestamp;
// }
