import { expect } from "chai";
import { ContractTransactionReceipt, ethers, keccak256 } from "ethers";

import {
  HistoricalHeaderWitnessStruct,
  ProvableBeaconBlockHeaderStruct,
  ValidatorWitnessStruct,
} from "typechain-types/contracts/0.8.25/ValidatorExitDelayVerifier.sol/ValidatorExitDelayVerifier";

import { de0x, findEventsWithInterfaces, numberToHex } from "lib";

import { BlockHeader, ValidatorStateProof } from "./validatorState";

export interface ExitRequest {
  pubkey: string;
  nodeOpId: number;
  moduleId: number;
  valIndex: number;
}

export const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, pubkey }: ExitRequest) => {
  const pubkeyHex = de0x(pubkey);
  expect(pubkeyHex.length).to.equal(48 * 2);
  return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
};

export const encodeExitRequestsDataList = (requests: ExitRequest[]) => {
  return "0x" + requests.map(encodeExitRequestHex).join("");
};

export const encodeExitRequestsDataListWithFormat = (requests: ExitRequest[]) => {
  const encodedExitRequests = { data: encodeExitRequestsDataList(requests), dataFormat: 1n };

  const encodedExitRequestsHash = keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["bytes", "uint256"],
      [encodedExitRequests.data, encodedExitRequests.dataFormat],
    ),
  );

  return { encodedExitRequests, encodedExitRequestsHash };
};

const stakingRouterMockEventABI = [
  "event UnexitedValidatorReported(uint256 moduleId, uint256 nodeOperatorId, uint256 proofSlotTimestamp, bytes publicKey, uint256 secondsSinceEligibleExitRequest)",
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
    withdrawableEpoch: validatorStateProof.validator.withdrawableEpoch,
    slashed: validatorStateProof.validator.slashed,
    validatorProof: validatorStateProof.validatorProof,
  };
}

export function toHistoricalHeaderWitness(validatorStateProf: ValidatorStateProof): HistoricalHeaderWitnessStruct {
  return {
    header: validatorStateProf.beaconBlockHeader,
    proof: validatorStateProf.historicalRootProof,
  };
}
