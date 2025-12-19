import { hexlify, parseUnits, randomBytes, zeroPadBytes, zeroPadValue } from "ethers";
import { ethers } from "hardhat";

import { PublicKey, SecretKey, Signature, verify } from "@chainsafe/blst";

import { IStakingVault, SSZBLSHelpers, SSZMerkleTree } from "typechain-types";
import {
  BLS12_381,
  PredepositGuarantee,
} from "typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";

import { computeDepositDataRoot, computeDepositMessageRoot, de0x, ether, impersonate } from "lib";

export type Validator = { container: SSZBLSHelpers.ValidatorStruct; blsPrivateKey: SecretKey };

export const randomBytes32 = (): string => hexlify(randomBytes(32));
export const randomValidatorPubkey = (): string => hexlify(randomBytes(48));

export const randomInt = (max: number): number => Math.floor(Math.random() * max);
const ikm = Uint8Array.from(Buffer.from("test test test test test test test", "utf-8"));
const masterSecret = SecretKey.deriveMasterEip2333(ikm);
const FAR_FUTURE_EPOCH = 2n ** 64n - 1n;
// Start from a pseudo-random child index so that every test run exercises a different
// sequence of BLS keys, while still being deterministic within a single process.
let secretIndex = randomInt(1_000_000);

export const addressToWC = (address: string, version = 2) =>
  `${hexlify(new Uint8Array([version]))}${"00".repeat(11)}${de0x(address.toLowerCase())}`;

export const generateValidator = (customWC?: string, fresh: boolean = false): Validator => {
  const secretKey = masterSecret.deriveChildEip2333(secretIndex++);

  return {
    blsPrivateKey: secretKey,
    container: {
      pubkey: secretKey.toPublicKey().toHex(true),
      withdrawalCredentials: customWC ?? hexlify(randomBytes32()),
      effectiveBalance: parseUnits(randomInt(32).toString(), "gwei"),
      slashed: false,
      activationEligibilityEpoch: fresh ? FAR_FUTURE_EPOCH : randomInt(343300),
      activationEpoch: fresh ? FAR_FUTURE_EPOCH : randomInt(343300),
      exitEpoch: fresh ? FAR_FUTURE_EPOCH : randomInt(343300),
      withdrawableEpoch: fresh ? FAR_FUTURE_EPOCH : randomInt(343300),
    },
  };
};

type GeneratePredepositOptions = {
  overrideAmount?: bigint;
  depositDomain?: string;
  pubkeyFlipBitmask?: number;
  signatureFlipBitmask?: number;
};

function overrideLeftmost3Bits(nibble: number, new3Bits: number): number {
  // Ensure the input is a single hexadecimal nibble (0-15)
  if (nibble < 0 || nibble > 15 || !Number.isInteger(nibble)) {
    throw new Error("Nibble must be an integer between 0 and 15.");
  }

  const rightmostBit = nibble;

  const newLeftmostBits = (new3Bits & 0b0111) << 1;

  const result = newLeftmostBits ^ rightmostBit;

  return result;
}

export const generatePredeposit = async (
  validator: Validator,
  options = {} as GeneratePredepositOptions,
): Promise<{ deposit: IStakingVault.DepositStruct; depositY: BLS12_381.DepositYStruct }> => {
  const { overrideAmount = ether("1"), depositDomain, pubkeyFlipBitmask, signatureFlipBitmask } = options;
  const amount = overrideAmount;
  const pubkey = validator.blsPrivateKey.toPublicKey();

  const canonPubkey = pubkey.toHex(true);
  let flippedPubkey = canonPubkey;
  if (typeof pubkeyFlipBitmask === "number") {
    const nibToFlip = Number.parseInt(canonPubkey.slice(2, 3), 16);
    const flippedNib = overrideLeftmost3Bits(nibToFlip, pubkeyFlipBitmask);
    const hexNib = flippedNib.toString(16);
    if (hexNib.length > 1) throw new Error("invariant");
    flippedPubkey = `0x${hexNib}${canonPubkey.slice(3)}`;
  }

  const messageRoot = await computeDepositMessageRoot(
    flippedPubkey,
    hexlify(validator.container.withdrawalCredentials),
    amount,
    depositDomain,
  );

  const pubkeyY = pubkey.toBytes(false).slice(48);
  // pad Y.a to 32 bytes to match Fp struct
  const pubkeyY_a = zeroPadValue(pubkeyY.slice(0, 16), 32);
  const pubkeyY_b = zeroPadValue(pubkeyY.slice(16), 32);

  const signature = validator.blsPrivateKey.sign(messageRoot);

  const signatureY = signature.toBytes(false).slice(96);

  let flippedSignature = signature.toHex(true);
  if (typeof signatureFlipBitmask === "number") {
    const nibToFlip = Number.parseInt(flippedSignature.slice(2, 3), 16);
    const flippedNib = overrideLeftmost3Bits(nibToFlip, signatureFlipBitmask);
    const hexNib = flippedNib.toString(16);
    if (hexNib.length > 1) throw new Error("invariant");
    flippedSignature = `0x${hexNib}${flippedSignature.slice(3)}`;
  }

  // first Fp of Y coordinate is last 48 bytes of signature
  const sigY_c0 = signatureY.slice(48);
  const sigY_c0_a = zeroPadValue(sigY_c0.slice(0, 16), 32);
  const sigY_c0_b = zeroPadValue(sigY_c0.slice(16), 32);
  // second Fp is 48 bytes before first one
  const sigY_c1 = signatureY.slice(0, 48);
  const sigY_c1_a = zeroPadValue(sigY_c1.slice(0, 16), 32);
  const sigY_c1_b = zeroPadValue(sigY_c1.slice(16), 32);

  let offChainVerification;
  try {
    offChainVerification = verify(
      messageRoot,
      PublicKey.fromHex(flippedPubkey, false),
      Signature.fromHex(flippedSignature, false),
      true,
      true,
    );
  } catch {
    offChainVerification = false;
  }

  if (typeof signatureFlipBitmask === "number" || typeof pubkeyFlipBitmask === "number") {
    if (offChainVerification)
      throw new Error(
        `invariant: off-chain verification should fail with flipped bits pk:${flippedPubkey},sig:${flippedSignature}`,
      );
  } else if (!offChainVerification) {
    throw new Error(`invariant: off-chain verification failed pk:${flippedPubkey},sig:${flippedSignature}`);
  }

  return {
    deposit: {
      pubkey: flippedPubkey,
      amount,
      signature: flippedSignature,
      depositDataRoot: computeDepositDataRoot(
        hexlify(validator.container.withdrawalCredentials),
        flippedPubkey,
        flippedSignature,
        amount,
      ),
    },
    depositY: {
      pubkeyY: {
        a: pubkeyY_a,
        b: pubkeyY_b,
      },
      signatureY: {
        c0_a: sigY_c0_a,
        c0_b: sigY_c0_b,
        c1_a: sigY_c1_a,
        c1_b: sigY_c1_b,
      },
    },
  };
};

export const generateTopUp = (
  validator: SSZBLSHelpers.ValidatorStruct,
  amount = ether("31"),
): PredepositGuarantee.ValidatorTopUpStruct => {
  return {
    pubkey: validator.pubkey,
    amount,
  };
};

export const generateDepositStruct = (
  validator: SSZBLSHelpers.ValidatorStruct,
  amount = ether("31"),
): IStakingVault.DepositStruct => {
  // signature is not checked for post-deposit
  const signature = zeroPadBytes("0x00", 96);
  return {
    pubkey: validator.pubkey,
    amount,
    signature,
    depositDataRoot: computeDepositDataRoot(
      hexlify(validator.withdrawalCredentials),
      hexlify(validator.pubkey),
      hexlify(signature),
      amount,
    ),
  };
};

export const generateBeaconHeader = (stateRoot: string, slot?: number) => {
  return {
    slot: slot ?? randomInt(1743359),
    proposerIndex: randomInt(1337),
    parentRoot: randomBytes32(),
    stateRoot,
    bodyRoot: randomBytes32(),
  };
};

export const setBeaconBlockRoot = async (root: string) => {
  const systemSigner = await impersonate("0xfffffffffffffffffffffffffffffffffffffffe", 999999999999999999999999999n);
  const BEACON_ROOTS = "0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02";
  const block = await systemSigner
    .sendTransaction({
      to: BEACON_ROOTS,
      value: 0,
      data: root,
    })
    .then((tx) => tx.getBlock());
  if (!block) throw new Error("invariant");
  return block.timestamp;
};

export interface LocalMerkleTree {
  sszMerkleTree: SSZMerkleTree;
  firstValidatorLeafIndex: bigint;
  gIFirstValidator: string;
  totalValidators: number;
  addValidator: (validator: SSZBLSHelpers.ValidatorStruct) => Promise<{ validatorIndex: number }>;
  validatorAtIndex: (index: number) => SSZBLSHelpers.ValidatorStruct;
  commitChangesToBeaconRoot: (
    slot?: number,
  ) => Promise<{ childBlockTimestamp: number; beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct }>;
  buildProof: (validatorIndex: number, beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct) => Promise<string[]>;
}

// Default mainnet values for validator state tree
export const prepareLocalMerkleTree = async (
  gIndex = "0x0000000000000000000000000000000000000000000000000096000000000028",
): Promise<LocalMerkleTree> => {
  const sszMerkleTree: SSZMerkleTree = await ethers.deployContract("SSZMerkleTree", [gIndex], {});
  const firstValidator = generateValidator();

  await sszMerkleTree.addValidatorLeaf(firstValidator.container);
  const validators: SSZBLSHelpers.ValidatorStruct[] = [firstValidator.container];

  const firstValidatorLeafIndex = (await sszMerkleTree.leafCount()) - 1n;
  const gIFirstValidator = await sszMerkleTree.getGeneralizedIndex(firstValidatorLeafIndex);

  // compare GIndex.index()
  if (BigInt(gIFirstValidator) >> 8n !== BigInt(gIndex) >> 8n)
    throw new Error("Invariant: sszMerkleTree implementation is broken");

  const addValidator = async (validator: SSZBLSHelpers.ValidatorStruct) => {
    await sszMerkleTree.addValidatorLeaf(validator);
    validators.push(validator);

    return {
      validatorIndex: validators.length - 1,
    };
  };

  const validatorAtIndex = (index: number) => {
    return validators[index];
  };

  const commitChangesToBeaconRoot = async (slot?: number) => {
    const beaconBlockHeader = generateBeaconHeader(await sszMerkleTree.getMerkleRoot(), slot);
    const beaconBlockHeaderHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(beaconBlockHeader);
    return {
      childBlockTimestamp: await setBeaconBlockRoot(beaconBlockHeaderHash),
      beaconBlockHeader,
    };
  };

  const buildProof = async (
    validatorIndex: number,
    beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct,
  ): Promise<string[]> => {
    const [validatorProof, stateProof, beaconBlockProof] = await Promise.all([
      sszMerkleTree.getValidatorPubkeyWCParentProof(validators[Number(validatorIndex)]).then((r) => r.proof),
      sszMerkleTree.getMerkleProof(BigInt(validatorIndex) + firstValidatorLeafIndex),
      sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader).then((r) => r.proof),
    ]);

    return [...validatorProof, ...stateProof, ...beaconBlockProof];
  };

  return {
    sszMerkleTree,
    gIFirstValidator,
    firstValidatorLeafIndex,
    get totalValidators(): number {
      return validators.length;
    },
    addValidator,
    validatorAtIndex,
    commitChangesToBeaconRoot,
    buildProof,
  };
};

export enum PDGPolicy {
  STRICT,
  ALLOW_PROVE,
  ALLOW_DEPOSIT_AND_PROVE,
}

export enum ValidatorStage {
  NONE,
  PREDEPOSITED,
  PROVEN,
  ACTIVATED,
  COMPENSATED,
}
