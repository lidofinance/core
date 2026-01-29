import { ethers } from "hardhat";

import { SSZBLSHelpers, SSZValidatorsMerkleTree } from "typechain-types";

import { generateValidator } from "lib";

const DEFAULT_GI_VALIDATOR_0 = "0x0000000000000000000000000000000000000000000000000096000000000028";

export const prepareLocalMerkleTree = async (giValidator0: string = DEFAULT_GI_VALIDATOR_0) => {
  // deploy helper tree validators+balances
  const stateTree: SSZValidatorsMerkleTree = await ethers.deployContract("SSZValidatorsMerkleTree", [giValidator0], {});

  // generate first validator
  const firstValidator = generateValidator();

  await stateTree.addValidatorsLeaf(firstValidator.container);

  // Index of first validator leafCount-1
  const validatorsLeafCount = await stateTree.validatorsLeafCount();

  const firstValidatorLeafIndex = validatorsLeafCount - 1n;

  // generalized for validators[firstValidatorLeafIndex]
  const gIFirstValidator = await stateTree.getValidatorGeneralizedIndex(firstValidatorLeafIndex);
  if (BigInt(gIFirstValidator) >> 8n === 0n) throw new Error("Broken GIndex setup");

  const addValidator = async (validator: SSZBLSHelpers.ValidatorStruct) => {
    await stateTree.addValidatorsLeaf(validator);

    const newValidatorsLeafCount = await stateTree.validatorsLeafCount();
    const validatorIndex = Number(newValidatorsLeafCount - 1n - firstValidatorLeafIndex);

    return {
      validatorIndex,
    };
  };

  return {
    stateTree,
    gIFirstValidator,
    firstValidatorLeafIndex,
    firstValidator,
    addValidator,
  };
};
