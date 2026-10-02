import { BigNumberish } from "ethers";
import { ethers } from "hardhat";

import { SSZValidatorsMerkleTree } from "typechain-types";

import { generateValidator, MAINNET_FIRST_VALIDATOR_GINDEX_PRE_GLOAS } from "lib";

export const prepareLocalMerkleTree = async (giValidator0: BigNumberish = MAINNET_FIRST_VALIDATOR_GINDEX_PRE_GLOAS) => {
  const stateTree: SSZValidatorsMerkleTree = await ethers.deployContract("SSZValidatorsMerkleTree", [giValidator0], {});

  // leafCount before adding = offset to validators field (22*2^40 for mainnet GI)
  const firstValidatorLeafIndex = await stateTree.leafCount();

  // generate first validator to initialize the tree
  const firstValidator = generateValidator();
  await stateTree.addValidatorsLeaf(firstValidator.container);

  // GI of validator[0] is known from the spec
  const gIFirstValidator = BigInt(giValidator0);

  return {
    stateTree,
    gIFirstValidator,
    firstValidatorLeafIndex,
    firstValidator,
  };
};
