import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { CLProofVerifier__Harness } from "typechain-types";
import { ValidatorStruct } from "typechain-types/contracts/0.8.25/predeposit_guarantee/PredepositGuarantee";

import { ether } from "lib";

export const generateValidator = (customWC?: string, customPukey?: string): ValidatorStruct => {
  const randomInt = (max: number): number => Math.floor(Math.random() * max);
  const randomBytes32 = (): string => hexlify(randomBytes(32));
  const randomValidatorPubkey = (): string => hexlify(randomBytes(96));

  return {
    pubkey: customPukey ?? randomValidatorPubkey(),
    withdrawalCredentials: customWC ?? randomBytes32(),
    effectiveBalance: ether(randomInt(32).toString()),
    slashed: false,
    activationEligibilityEpoch: randomInt(343300),
    activationEpoch: randomInt(343300),
    exitEpoch: randomInt(343300),
    withdrawableEpoch: randomInt(343300),
  };
};

// random number integer generator

describe("CLProofVerifier.sol", () => {
  let CLProofVerifier: CLProofVerifier__Harness;
  before(async () => {
    CLProofVerifier = await ethers.deployContract("CLProofVerifier__Harness", {});
  });

  it("should verify validator object in merkle tree", async () => {
    const validator = generateValidator();
    await CLProofVerifier.TEST_addValidatorLeaf(validator);
    const validator_index = await CLProofVerifier.TEST_lastIndex();
    const proofs = await CLProofVerifier.TEST_getProof(validator_index);

    await CLProofVerifier.TEST_validateWCProof(validator, proofs, 1);
  });
});
