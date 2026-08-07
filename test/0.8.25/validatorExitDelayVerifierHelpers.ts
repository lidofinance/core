import { expect } from "chai";
import { ContractTransactionReceipt, ethers, keccak256 } from "ethers";

import { ByteVectorType, VectorCompositeType } from "@chainsafe/ssz";

import {
  BlockRootsHeaderWitnessStruct,
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

// `block_roots` is Vector[Root, SLOTS_PER_HISTORICAL_ROOT]. SSZ gives us the generalized index of
// element `rootIndex` within that vector (which encodes the vector's tree depth); we then concat
// it under the provided `block_roots` field gindex.
const SLOTS_PER_HISTORICAL_ROOT = 8192;
const Root = new ByteVectorType(32);
const BlockRootsType = new VectorCompositeType(Root, SLOTS_PER_HISTORICAL_ROOT);

// Generalized index (in GIndex packed form, i.e. `rawGindex << 8`) of `block_roots[targetSlot % N]`
// for a `block_roots` field located at `fieldGindex`.
export function blockRootsLeafGIndex(fieldGindex: bigint, targetSlot: bigint): bigint {
  const rootIndex = Number(targetSlot % BigInt(SLOTS_PER_HISTORICAL_ROOT));
  const elementGindex = BlockRootsType.getPathInfo([rootIndex]).gindex; // 2**depth | rootIndex
  const depth = BigInt(elementGindex.toString(2).length - 1);
  const rawGindex = (fieldGindex << depth) | (elementGindex - (1n << depth)); // concat under the field
  return rawGindex << 8n;
}

function toLittleEndian(value: bigint): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 8; i++) {
    bytes[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return ethers.hexlify(bytes);
}

function hashPair(left: string, right: string): string {
  return ethers.sha256(ethers.concat([left, right]));
}

function hashBeaconBlockHeader(header: BlockHeader): string {
  let nodes = [
    toLittleEndian(BigInt(header.slot)),
    toLittleEndian(BigInt(header.proposerIndex)),
    header.parentRoot,
    header.stateRoot,
    header.bodyRoot,
    ethers.ZeroHash,
    ethers.ZeroHash,
    ethers.ZeroHash,
  ];

  while (nodes.length > 1) {
    nodes = nodes.reduce<string[]>((next, node, index) => {
      if (index % 2 === 0) next.push(hashPair(node, nodes[index + 1]));
      return next;
    }, []);
  }
  return nodes[0];
}

export function createBlockRootsProof(targetHeader: BlockHeader): {
  recentBlock: BlockHeader;
  recentBlockRoot: string;
  targetBlock: BlockRootsHeaderWitnessStruct;
} {
  // A synthetic all-zero-sibling proof is enough here: we set recentBlock.stateRoot to whatever
  // root it reconstructs, so the proof is self-consistent for the pre-Gloas block_roots field.
  const slotsPerHistoricalRoot = 8192n;
  const targetSlot = BigInt(targetHeader.slot);
  let gI = (0x45n << 13n) | targetSlot % slotsPerHistoricalRoot;
  const proof = Array<string>(19).fill(ethers.ZeroHash);
  let stateRoot = hashBeaconBlockHeader(targetHeader);

  for (const sibling of proof) {
    stateRoot = gI & 1n ? hashPair(sibling, stateRoot) : hashPair(stateRoot, sibling);
    gI >>= 1n;
  }

  const recentBlock: BlockHeader = {
    slot: targetHeader.slot + 1,
    proposerIndex: "0",
    parentRoot: ethers.ZeroHash,
    stateRoot,
    bodyRoot: ethers.ZeroHash,
  };

  return {
    recentBlock,
    recentBlockRoot: hashBeaconBlockHeader(recentBlock),
    targetBlock: { header: targetHeader, proof },
  };
}
