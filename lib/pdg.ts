import { hexlify, parseUnits, randomBytes, zeroPadBytes, zeroPadValue } from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import { setCode } from "@nomicfoundation/hardhat-network-helpers";

import { IStakingVault, SSZHelpers, SSZMerkleTree } from "typechain-types";
import { BLS } from "typechain-types/contracts/0.8.25/vaults/predeposit_guarantee/PredepositGuarantee";

import { computeDepositDataRoot, computeDepositMessageRoot, ether, impersonate } from "lib";

export type Validator = { container: SSZHelpers.ValidatorStruct; blsPrivateKey: SecretKey };

export type LocalMerkle = Awaited<ReturnType<typeof prepareLocalMerkleTree>>;

export const randomBytes32 = (): string => hexlify(randomBytes(32));
export const randomValidatorPubkey = (): string => hexlify(randomBytes(48));

export const randomInt = (max: number): number => Math.floor(Math.random() * max);
const ikm = Uint8Array.from(Buffer.from("test test test test test test test", "utf-8"));
const masterSecret = SecretKey.deriveMasterEip2333(ikm);
let secretIndex = 0;

export const generateValidator = (customWC?: string): Validator => {
  const secretKey = masterSecret.deriveChildEip2333(secretIndex++);

  return {
    blsPrivateKey: secretKey,
    container: {
      pubkey: secretKey.toPublicKey().toHex(true),
      withdrawalCredentials: customWC ?? hexlify(randomBytes32()),
      effectiveBalance: parseUnits(randomInt(32).toString(), "gwei"),
      slashed: false,
      activationEligibilityEpoch: randomInt(343300),
      activationEpoch: randomInt(343300),
      exitEpoch: randomInt(343300),
      withdrawableEpoch: randomInt(343300),
    },
  };
};

export const generatePredeposit = async (
  validator: Validator,
): Promise<{ deposit: IStakingVault.DepositStruct; depositY: BLS.DepositYStruct }> => {
  const amount = ether("1");
  const pubkey = validator.blsPrivateKey.toPublicKey();

  const messageRoot = await computeDepositMessageRoot(
    pubkey.toHex(true),
    hexlify(validator.container.withdrawalCredentials),
    amount,
  );

  const pubkeyY = pubkey.toBytes(false).slice(48);
  // pad Y.a to 32 bytes to match Fp struct
  const pubkeyY_a = zeroPadValue(pubkeyY.slice(0, 16), 32);
  const pubkeyY_b = zeroPadValue(pubkeyY.slice(16), 32);

  const signature = validator.blsPrivateKey.sign(messageRoot);

  const signatureY = signature.toBytes(false).slice(96);

  // first Fp of Y coordinate is last 48 bytes of signature
  const sigY_c0 = signatureY.slice(48);
  const sigY_c0_a = zeroPadValue(sigY_c0.slice(0, 16), 32);
  const sigY_c0_b = zeroPadValue(sigY_c0.slice(16), 32);
  // second Fp is 48 bytes before first one
  const sigY_c1 = signatureY.slice(0, 48);
  const sigY_c1_a = zeroPadValue(sigY_c1.slice(0, 16), 32);
  const sigY_c1_b = zeroPadValue(sigY_c1.slice(16), 32);

  return {
    deposit: {
      pubkey: validator.container.pubkey,
      amount,
      signature: signature.toBytes(true),
      depositDataRoot: computeDepositDataRoot(
        hexlify(validator.container.withdrawalCredentials),
        validator.container.pubkey,
        signature.toBytes(true),
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

export const generatePostDeposit = (
  validator: SSZHelpers.ValidatorStruct,
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
  if (!block) throw new Error("ivariant");
  return block.timestamp;
};

export const deployBLSPrecompileStubs = async () => {
  const g2Add = await ethers.deployContract("BLSG2ADD__Mock");
  await setCode("0x000000000000000000000000000000000000000d", (await g2Add.getDeployedCode()) as string);

  const pair = await ethers.deployContract("BKSPAIR__Mock");
  await setCode("0x000000000000000000000000000000000000000F", (await pair.getDeployedCode()) as string);

  const mapFp2 = await ethers.deployContract("BKSMAPFP2__Mock");
  await setCode("0x0000000000000000000000000000000000000011", (await mapFp2.getDeployedCode()) as string);
};

// Default mainnet values for validator state tree
export const prepareLocalMerkleTree = async (
  gIndex = "0x0000000000000000000000000000000000000000000000000096000000000028",
) => {
  const sszMerkleTree: SSZMerkleTree = await ethers.deployContract("SSZMerkleTree", [gIndex], {});
  const firstValidator = generateValidator();

  await sszMerkleTree.addValidatorLeaf(firstValidator.container);
  const validators: SSZHelpers.ValidatorStruct[] = [firstValidator.container];

  const firstValidatorLeafIndex = (await sszMerkleTree.leafCount()) - 1n;
  const gIFirstValidator = await sszMerkleTree.getGeneralizedIndex(firstValidatorLeafIndex);

  // compare GIndex.index()
  if (BigInt(gIFirstValidator) >> 8n !== BigInt(gIndex) >> 8n)
    throw new Error("Invariant: sszMerkleTree implementation is broken");

  const addValidator = async (validator: SSZHelpers.ValidatorStruct) => {
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
    beaconBlockHeader: SSZHelpers.BeaconBlockHeaderStruct,
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
