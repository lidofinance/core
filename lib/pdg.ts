import { hexlify, parseUnits, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { IStakingVault, SSZHelpers, SSZMerkleTree } from "typechain-types";

import { computeDepositDataRoot, ether, impersonate } from "lib";

export const randomBytes32 = (): string => hexlify(randomBytes(32));
export const randomValidatorPubkey = (): string => hexlify(randomBytes(48));

export const randomInt = (max: number): number => Math.floor(Math.random() * max);

export const generateValidator = (customWC?: string, customPukey?: string): SSZHelpers.ValidatorStruct => {
  return {
    pubkey: customPukey ?? randomValidatorPubkey(),
    withdrawalCredentials: customWC ?? randomBytes32(),
    effectiveBalance: parseUnits(randomInt(32).toString(), "gwei"),
    slashed: false,
    activationEligibilityEpoch: randomInt(343300),
    activationEpoch: randomInt(343300),
    exitEpoch: randomInt(343300),
    withdrawableEpoch: randomInt(343300),
  };
};

export const generatePredeposit = (validator: SSZHelpers.ValidatorStruct): IStakingVault.DepositStruct => {
  const signature = randomBytes(96);
  const amount = ether("1");
  return {
    pubkey: validator.pubkey,
    amount,
    signature: signature,
    depositDataRoot: computeDepositDataRoot(
      hexlify(validator.withdrawalCredentials),
      hexlify(validator.pubkey),
      hexlify(signature),
      amount,
    ),
  };
};

export const generatePostDeposit = (
  validator: SSZHelpers.ValidatorStruct,
  amount = ether("31"),
): IStakingVault.DepositStruct => {
  return {
    pubkey: validator.pubkey,
    amount,
    signature: randomBytes(96),
    depositDataRoot: randomBytes32(),
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

// Default mainnet values for validator state tree
export const prepareLocalMerkleTree = async (
  gIndex = "0x0000000000000000000000000000000000000000000000000096000000000028",
) => {
  const sszMerkleTree: SSZMerkleTree = await ethers.deployContract("SSZMerkleTree", [gIndex], {});
  const firstValidator = generateValidator();
  await sszMerkleTree.addValidatorLeaf(firstValidator);
  const validators: SSZHelpers.ValidatorStruct[] = [firstValidator];

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
