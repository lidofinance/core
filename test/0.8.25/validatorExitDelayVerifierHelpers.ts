import { expect } from "chai";
import { ContractTransactionReceipt, ethers, hexlify, keccak256 } from "ethers";
import { ethers as hre } from "hardhat";

import { ValidatorExitDelayVerifier } from "typechain-types";
import {
  HistoricalHeaderWitnessStruct,
  ProvableBeaconBlockHeaderStruct,
  ValidatorWitnessStruct,
} from "typechain-types/contracts/0.8.25/ValidatorExitDelayVerifier.sol/ValidatorExitDelayVerifier";

import { de0x, findEventsWithInterfaces, generateBeaconHeader, generateValidator, numberToHex } from "lib";

import { BlockHeader, ValidatorStateProof } from "./validatorState";

const FAR_FUTURE_EPOCH = (1n << 64n) - 1n;

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

export interface GeneratedValidatorProof {
  pubkey: string;
  validatorIndex: number;
  header: BlockHeader;
  headerRoot: string;
  witness: ValidatorWitnessStruct;
}

/**
 * Builds a validator inclusion proof against a freshly generated CL state tree.
 *
 * The verifier only checks internal consistency — that the EIP-4788 root matches the header and
 * that the leaf proves against `header.stateRoot` — so a synthesized tree serves as well as a
 * captured mainnet one, and unlike a captured one it follows whichever fork layout the deployed
 * verifier is configured for.
 *
 * The generalized index is recomputed here rather than read back from the verifier: asking the
 * contract which index it wants and then proving at that index would make the test circular and
 * blind to a wrong derivation rule.
 */
export async function generateValidatorStateProof(
  verifier: ValidatorExitDelayVerifier,
  slot: number,
  validatorIndex: number,
  exitRequestIndex = 0,
): Promise<GeneratedValidatorProof> {
  const gIndexLib = await hre.deployContract("GIndex__Harness");
  const gloasSlot = await verifier.GLOAS_SLOT();

  const validatorGI =
    BigInt(slot) < gloasSlot
      ? await gIndexLib.shr(await verifier.GI_FIRST_VALIDATOR_PRE_GLOAS(), validatorIndex)
      : await gIndexLib.concat(await verifier.GI_VALIDATORS(), await gIndexLib.progressiveListNode(validatorIndex));

  const { container } = generateValidator();
  const provenContainer = {
    ...container,
    // Pin the activation epochs. The verifier refuses a proof taken before the validator could
    // have exited voluntarily, and `generateValidator` randomises the activation epoch far enough
    // out that the earliest possible exit would land years past any slot a test picks.
    activationEligibilityEpoch: 10n,
    activationEpoch: 16n,
    // The verifier rebuilds the leaf with `exitEpoch == FAR_FUTURE_EPOCH`, so the committed leaf
    // has to carry the same value or the roots will not match.
    exitEpoch: FAR_FUTURE_EPOCH,
  };

  const stateTree = await hre.deployContract("SSZMerkleTree", [validatorGI]);
  const leafIndex = await stateTree.leafCount();
  await stateTree.addValidatorLeaf(provenContainer);

  const validatorProof = await stateTree.getMerkleProof(leafIndex);
  const stateRoot = await stateTree.getMerkleRoot();

  const generated = generateBeaconHeader(stateRoot, slot);
  const header: BlockHeader = { ...generated, slot, proposerIndex: String(generated.proposerIndex) };
  const headerRoot = await stateTree.beaconBlockHeaderHashTreeRoot(header);

  return {
    pubkey: hexlify(provenContainer.pubkey),
    validatorIndex,
    header,
    headerRoot,
    witness: {
      exitRequestIndex,
      withdrawalCredentials: provenContainer.withdrawalCredentials,
      effectiveBalance: provenContainer.effectiveBalance,
      activationEligibilityEpoch: provenContainer.activationEligibilityEpoch,
      activationEpoch: provenContainer.activationEpoch,
      withdrawableEpoch: provenContainer.withdrawableEpoch,
      slashed: provenContainer.slashed,
      validatorProof: [...validatorProof],
    },
  };
}
