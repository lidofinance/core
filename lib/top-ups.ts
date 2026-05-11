import { ethers } from "hardhat";

import { SSZValidatorsMerkleTree } from "typechain-types";

import { generateValidator } from "lib";

const DEFAULT_GI_VALIDATOR_0 = "0x0000000000000000000000000000000000000000000000000096000000000028";

export const prepareLocalMerkleTree = async (giValidator0: string = DEFAULT_GI_VALIDATOR_0) => {
  const stateTree: SSZValidatorsMerkleTree = await ethers.deployContract("SSZValidatorsMerkleTree", [giValidator0], {});

  // leafCount before adding = offset to validators field (22*2^40 for mainnet GI)
  const firstValidatorLeafIndex = await stateTree.leafCount();

  // generate first validator to initialize the tree
  const firstValidator = generateValidator();
  await stateTree.addValidatorsLeaf(firstValidator.container);

  // GI of validator[0] is known from the spec
  const gIFirstValidator = giValidator0;

  return {
    stateTree,
    gIFirstValidator,
    firstValidatorLeafIndex,
    firstValidator,
  };
};
