import { expect } from "chai";
import { ethers } from "hardhat";

import { CLTopUpVerifier__Harness, SSZValidatorsMerkleTree } from "typechain-types";

import { generateBeaconHeader, generateValidator, randomBytes32, setBeaconBlockRoot } from "lib/pdg";
import { prepareLocalMerkleTree } from "lib/top-ups";

describe("CLTopUpProofVerifier", () => {
  let sszMerkleTree: SSZValidatorsMerkleTree;
  let gIFirstValidator: string;
  let firstValidatorLeafIndex: bigint;
  let verifier: CLTopUpVerifier__Harness;

  before(async () => {
    // 1) Build a local SSZ tree once
    const localTree = await prepareLocalMerkleTree();
    sszMerkleTree = localTree.stateTree;
    gIFirstValidator = localTree.gIFirstValidator;
    firstValidatorLeafIndex = localTree.firstValidatorLeafIndex;

    // populate merkle tree with validators
    for (let i = 1; i < 100; i++) {
      const v = generateValidator().container;
      await sszMerkleTree.addValidatorsLeaf(v);
    }

    // 2) Deploy the verifier (same GI for prev/curr, no pivot)
    verifier = await ethers.deployContract("CLTopUpVerifier__Harness", [
      gIFirstValidator, // GI_FIRST_VALIDATOR_PREV
      gIFirstValidator, // GI_FIRST_VALIDATOR_CURR
      0, // PIVOT_SLOT
    ]);
  });

  it("verifies full Validator container at head under EIP-4788", async () => {
    // 1) Create an 'active' validator at the target epoch
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 2n;
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    // Insert validator into the local SSZ tree
    await sszMerkleTree.addValidatorsLeaf(v.container);

    // Compute its index in validators[i]
    const leafCount = await sszMerkleTree.validatorsLeafCount();
    // Index = (current leaves - 1) - firstValidatorLeafIndex
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    // Anchor the current state_root into EIP-4788 via a header at SLOT
    const SLOT = 3200; // epoch = 100 (greater than activationEpoch)
    const stateRoot = await sszMerkleTree.getStateRoot();
    const beaconBlockHeader = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(beaconBlockHeader);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    // Build proof:
    //    - stateProof: validators[i] → validators_root → state_root
    //    - headerProof: state_root → … → beacon_block_root (contains parent(slot, proposer) node)
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));

    // state_root -> beacon_block_root
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconBlockHeader);
    const proofValidator = [...validator_proofs, ...headerMerkle.proof];

    const beaconRootData = {
      childBlockTimestamp,
      slot: beaconBlockHeader.slot,
      proposerIndex: beaconBlockHeader.proposerIndex,
    };

    // 2) Validator witness (validator container only)
    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    // 4) Call harness
    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);

    // 5) Negative: wrong WC must fail
    const wrongWC = "0x" + "11".repeat(32);
    await expect(verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, wrongWC)).to.be
      .reverted;
  });

  it("don't revert with ValidatorIsSlashed when slashed = true", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = true;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 2n;
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200; // epoch = 100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    // validator[i] -> validators_root -> state_root'
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));

    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];

    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };

    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await expect(verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC)).to.not.be
      .rejected;
  });

  it("don't revert when activationEpoch > epoch(slot)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 101n; // > epoch(slot=3200)=100
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200;
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];

    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };

    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);
  });

  it("don't reverts when activationEpoch == epoch(slot)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;
    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 100n; // == epoch(slot)
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;
    const expectedWC = v.container.withdrawalCredentials;
    await sszMerkleTree.addValidatorsLeaf(v.container);
    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);
    const SLOT = 3200; // epoch=100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);
    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };
    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);
  });

  it("don't revert when a validator with non-FAR_FUTURE exitEpoch (proof mismatch)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;
    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 70n;
    v.container.activationEpoch = 90n;
    const SLOT = 3200; // epoch(slot) = 100
    v.container.exitEpoch = 101n; //
    v.container.withdrawableEpoch = FAR_FUTURE;
    const expectedWC = v.container.withdrawalCredentials;
    await sszMerkleTree.addValidatorsLeaf(v.container);
    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);
    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const beaconRootData = {
      childBlockTimestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    };
    const validatorWitness = {
      proofValidator,
      pubkey: v.container.pubkey,
      effectiveBalance: v.container.effectiveBalance,
      slashed: v.container.slashed,
      exitEpoch: v.container.exitEpoch,
      activationEligibilityEpoch: v.container.activationEligibilityEpoch,
      activationEpoch: v.container.activationEpoch,
      withdrawableEpoch: v.container.withdrawableEpoch,
    };

    await verifier.TEST_verifyValidator(beaconRootData, validatorWitness, validatorIndex, expectedWC);
  });

  it("should change gIndex on pivot slot", async () => {
    const pivotSlot = 1000;
    const giPrev = randomBytes32();
    const giCurr = randomBytes32();

    const proofVerifier = await ethers.deployContract("CLTopUpVerifier__Harness", [giPrev, giCurr, pivotSlot], {});
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot - 1)).to.equal(giPrev);
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot)).to.equal(giCurr);
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot + 1)).to.equal(giCurr);
  });
});
