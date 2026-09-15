import { expect } from "chai";
import { ethers } from "hardhat";

import { mine } from "@nomicfoundation/hardhat-network-helpers";

import { CLProofVerifier__Harness, SSZMerkleTree } from "typechain-types";

import {
  generateBeaconHeader,
  generateValidator,
  prepareLocalMerkleTree,
  randomBytes32,
  setBeaconBlockRoot,
} from "lib";

import { Snapshot } from "test/suite";

const MAX_UINT64 = (1n << 64n) - 1n;

describe("CLProofVerifier.sol", () => {
  let CLProofVerifier: CLProofVerifier__Harness;
  let sszMerkleTree: SSZMerkleTree;
  let firstValidatorLeafIndex: bigint;
  let lastValidatorIndex: bigint;

  let snapshotState: string;

  before(async () => {
    const localTree = await prepareLocalMerkleTree();
    sszMerkleTree = localTree.sszMerkleTree;
    firstValidatorLeafIndex = localTree.firstValidatorLeafIndex;

    firstValidatorLeafIndex = localTree.firstValidatorLeafIndex;

    // populate merkle tree with validators
    for (let i = 1; i < 100; i++) {
      await sszMerkleTree.addValidatorLeaf(generateValidator().container);
    }

    // after adding validators, all newly added validator indexes will +n from this
    lastValidatorIndex = (await sszMerkleTree.leafCount()) - 1n - firstValidatorLeafIndex;

    CLProofVerifier = await ethers.deployContract("CLProofVerifier__Harness", [MAX_UINT64], {});

    // test mocker
    const mockRoot = randomBytes32();
    const timestamp = await setBeaconBlockRoot(mockRoot);
    expect(await CLProofVerifier.TEST_getParentBlockRoot(timestamp)).to.equal(mockRoot);
  });

  beforeEach(async () => {
    snapshotState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(snapshotState);
  });

  it("can verify against dynamic merkle tree", async () => {
    const validator = generateValidator();
    const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(validator.container);

    // verify just the validator container tree from PK+WC node
    await sszMerkleTree.verifyProof(
      [...validatorMerkle.proof],
      validatorMerkle.root,
      validatorMerkle.parentNode,
      validatorMerkle.parentIndex,
    );

    // add validator to CL state merkle tree
    await sszMerkleTree.addValidatorLeaf(validator.container);
    const validatorIndex = lastValidatorIndex + 1n;
    const stateRoot = await sszMerkleTree.getMerkleRoot();

    const validatorLeafIndex = firstValidatorLeafIndex + validatorIndex;
    const stateProof = await sszMerkleTree.getMerkleProof(validatorLeafIndex);
    const validatorGIndex = await sszMerkleTree.getGeneralizedIndex(validatorLeafIndex);

    expect(await CLProofVerifier.TEST_getValidatorGI(validatorIndex, 0)).to.equal(validatorGIndex);

    // verify just the state tree
    await sszMerkleTree.verifyProof([...stateProof], stateRoot, validatorMerkle.root, validatorGIndex);

    const beaconHeader = generateBeaconHeader(stateRoot);
    const beaconMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(beaconHeader);
    // verify just the beacon tree
    await sszMerkleTree.verifyProof([...beaconMerkle.proof], beaconMerkle.root, stateRoot, beaconMerkle.index);

    const timestamp = await setBeaconBlockRoot(beaconMerkle.root);

    const proof = [...validatorMerkle.proof, ...stateProof, ...beaconMerkle.proof];

    await CLProofVerifier.TEST_validatePubKeyWCProof(
      {
        validatorIndex,
        proof: [...proof],
        pubkey: validator.container.pubkey,
        childBlockTimestamp: timestamp,
        slot: beaconHeader.slot,
        proposerIndex: beaconHeader.proposerIndex,
      },
      validator.container.withdrawalCredentials,
    );
  });

  it("should change gIndex on Gloas slot", async () => {
    const gloasSlot = 1000;
    const clProofVerifier: CLProofVerifier__Harness = await ethers.deployContract(
      "CLProofVerifier__Harness",
      [gloasSlot],
      {},
    );

    expect(await clProofVerifier.TEST_getValidatorGI(1n, gloasSlot - 1)).to.equal(
      "0x0000000000000000000000000000000000000000000000000096000000000128",
    );
    expect(await clProofVerifier.TEST_getValidatorGI(0n, gloasSlot)).to.equal(
      "0x0000000000000000000000000000000000000000000000000000000000059800",
    );
    expect(await clProofVerifier.TEST_getValidatorGI(1n, gloasSlot + 1)).to.equal(
      "0x00000000000000000000000000000000000000000000000000000000002cc800",
    );
  });

  it("should validate proofs before and after Gloas", async () => {
    const provenValidator = generateValidator();
    const validatorMerkle = await sszMerkleTree.getValidatorPubkeyWCParentProof(provenValidator.container);
    const gloasSlot = 1000;

    const preparePreGloasCLState = async (slot: number) => {
      const { sszMerkleTree: localTree, firstValidatorLeafIndex: localFirstValidatorLeafIndex } =
        await prepareLocalMerkleTree();
      await localTree.addValidatorLeaf(provenValidator.container);

      const gIndexProven = await localTree.getGeneralizedIndex(localFirstValidatorLeafIndex + 1n);
      const stateProof = await localTree.getMerkleProof(localFirstValidatorLeafIndex + 1n);
      const beaconHeader = generateBeaconHeader(await localTree.getMerkleRoot(), slot);
      const beaconMerkle = await localTree.getBeaconBlockHeaderProof(beaconHeader);
      const proof = [...validatorMerkle.proof, ...stateProof, ...beaconMerkle.proof];

      return {
        gIndexProven,
        proof: [...proof],
        beaconHeader,
        beaconRoot: beaconMerkle.root,
      };
    };

    const prepareGloasCLState = async (slot: number) => {
      const localTree: SSZMerkleTree = await ethers.deployContract(
        "SSZMerkleTree",
        ["0x00000000000000000000000000000000000000000000000000000000002cc800"],
        {},
      );
      const validatorLeafIndex = await localTree.leafCount();
      await localTree.addValidatorLeaf(provenValidator.container);

      const stateProof = await localTree.getMerkleProof(validatorLeafIndex);
      const beaconHeader = generateBeaconHeader(await localTree.getMerkleRoot(), slot);
      const beaconMerkle = await localTree.getBeaconBlockHeaderProof(beaconHeader);

      return {
        gIndexProven: "0x00000000000000000000000000000000000000000000000000000000002cc800",
        proof: [...validatorMerkle.proof, ...stateProof, ...beaconMerkle.proof],
        beaconHeader,
        beaconRoot: beaconMerkle.root,
      };
    };

    const [prev, curr] = await Promise.all([preparePreGloasCLState(gloasSlot - 1), prepareGloasCLState(gloasSlot + 1)]);

    // current CL state

    const clProofVerifier: CLProofVerifier__Harness = await ethers.deployContract(
      "CLProofVerifier__Harness",
      [gloasSlot],
      {},
    );

    //

    expect(await clProofVerifier.TEST_getValidatorGI(1n, gloasSlot - 1)).to.equal(prev.gIndexProven);
    expect(await clProofVerifier.TEST_getValidatorGI(1n, gloasSlot)).to.equal(curr.gIndexProven);
    expect(await clProofVerifier.TEST_getValidatorGI(1n, gloasSlot + 1)).to.equal(curr.gIndexProven);

    // prev works
    const timestampPrev = await setBeaconBlockRoot(prev.beaconRoot);
    await clProofVerifier.TEST_validatePubKeyWCProof(
      {
        proof: prev.proof,
        validatorIndex: 1n,
        pubkey: provenValidator.container.pubkey,
        childBlockTimestamp: timestampPrev,
        slot: prev.beaconHeader.slot,
        proposerIndex: prev.beaconHeader.proposerIndex,
      },
      provenValidator.container.withdrawalCredentials,
    );

    await mine(1);

    // curr works
    const timestampCurr = await setBeaconBlockRoot(curr.beaconRoot);
    await clProofVerifier.TEST_validatePubKeyWCProof(
      {
        proof: [...curr.proof],
        validatorIndex: 1n,
        pubkey: provenValidator.container.pubkey,
        childBlockTimestamp: timestampCurr,
        slot: curr.beaconHeader.slot,
        proposerIndex: curr.beaconHeader.proposerIndex,
      },
      provenValidator.container.withdrawalCredentials,
    );

    // prev fails on curr slot
    await expect(
      clProofVerifier.TEST_validatePubKeyWCProof(
        {
          proof: [...prev.proof],
          validatorIndex: 1n,
          pubkey: provenValidator.container.pubkey,
          childBlockTimestamp: timestampCurr,
          // invalid slot to get wrong GIndex
          slot: curr.beaconHeader.slot,
          proposerIndex: curr.beaconHeader.proposerIndex,
        },
        provenValidator.container.withdrawalCredentials,
      ),
    ).to.be.revertedWithCustomError(CLProofVerifier, "InvalidSlot");
  });
});
