import { expect } from "chai";
import { ContractTransactionReceipt, ethers } from "ethers";

import {
  HistoricalHeaderWitnessStruct,
  ProvableBeaconBlockHeaderStruct,
  ValidatorWitnessStruct,
} from "typechain-types/contracts/0.8.25/ValidatorExitVerifier.sol/ValidatorExitVerifier";

import { de0x, findEventsWithInterfaces, numberToHex } from "lib";

import { BlockHeader, ValidatorStateProof } from "./validatorState";

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

export function toProvableBeaconBlockHeader(
  header: BlockHeader,
  rootsTimestamp: number,
): ProvableBeaconBlockHeaderStruct {
  return {
    header: header,
    rootsTimestamp,
  };
}

export function toValidatorWitness(
  validatorStateProof: ValidatorStateProof,
  exitRequestIndex: number,
): ValidatorWitnessStruct {
  return {
    exitRequestIndex,
    withdrawalCredentials: validatorStateProof.validator.withdrawalCredentials,
    effectiveBalance: validatorStateProof.validator.effectiveBalance,
    activationEligibilityEpoch: validatorStateProof.validator.activationEligibilityEpoch,
    activationEpoch: validatorStateProof.validator.activationEpoch,
    exitEpoch: validatorStateProof.validator.exitEpoch,
    withdrawableEpoch: validatorStateProof.validator.withdrawableEpoch,
    slashed: validatorStateProof.validator.slashed,
    validatorProof: validatorStateProof.validatorProof,
  };
}

export function toHistoricalHeaderWitness(validatorStateProf: ValidatorStateProof): HistoricalHeaderWitnessStruct {
  return {
    header: validatorStateProf.beaconBlockHeader,
    rootGIndex: validatorStateProf.historicalSummariesGI,
    proof: validatorStateProf.historicalRootProof,
  };
}
