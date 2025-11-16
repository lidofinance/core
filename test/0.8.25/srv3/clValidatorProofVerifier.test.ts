import { expect } from "chai";
import { parseUnits } from "ethers";
import { ethers } from "hardhat";

import { CLTopUpVerifier__Harness, SSZValidatorsAndBalancesMerkleTree } from "typechain-types";

import { generateBeaconHeader, generateValidator, randomBytes32, setBeaconBlockRoot } from "lib/pdg";
import { prepareLocalMerkleTree } from "lib/top-ups";

describe("CLValidatorProofVerifier", () => {
  let sszMerkleTree: SSZValidatorsAndBalancesMerkleTree;
  let gIFirstValidator: string;
  let firstValidatorLeafIndex: bigint;
  let gIFirstBalance: string;
  let firstBalanceLeafIndex: bigint;
  let gIFirstPendingDeposit: string;
  let firstPendingDepositLeafIndex: bigint;

  let verifier: CLTopUpVerifier__Harness;

  before(async () => {
    // 1) Build a local SSZ tree once
    const localTree = await prepareLocalMerkleTree();
    sszMerkleTree = localTree.stateTree;
    gIFirstValidator = localTree.gIFirstValidator;
    firstValidatorLeafIndex = localTree.firstValidatorLeafIndex;
    gIFirstBalance = localTree.gIFirstBalance;
    firstBalanceLeafIndex = localTree.firstBalanceLeafIndex;
    gIFirstBalance = localTree.gIFirstBalance;
    firstBalanceLeafIndex = localTree.firstBalanceLeafIndex;
    gIFirstPendingDeposit = localTree.gIFirstPendingDeposit;
    firstPendingDepositLeafIndex = localTree.firstPendingDepositLeafIndex;

    // populate merkle tree with validators
    for (let i = 1; i < 100; i++) {
      const v = generateValidator().container;
      await sszMerkleTree.addValidatorsLeaf(v);
      await sszMerkleTree.addBalancesLeaf(v.effectiveBalance);
    }

    // 2) Deploy the verifier (same GI for prev/curr, no pivot)
    verifier = await ethers.deployContract("CLTopUpVerifier__Harness", [
      gIFirstValidator, // GI_FIRST_VALIDATOR_PREV
      gIFirstValidator, // GI_FIRST_VALIDATOR_CURR
      gIFirstBalance, // GI_FIRST_BALANCE_PREV
      gIFirstBalance, // GI_FIRST_BALANCE_CURR
      gIFirstPendingDeposit,
      gIFirstPendingDeposit,
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
    await sszMerkleTree.addBalancesLeaf(v.container.effectiveBalance);

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

    // Build proof:
    //    - stateProof: balances[i] → balances_root → state_root
    //    - headerProof: state_root → … → beacon_block_root (contains parent(slot, proposer) node)
    const balance_proofs = await sszMerkleTree.getBalanceProof(firstBalanceLeafIndex + BigInt(validatorIndex));
    const proofBalance = [...balance_proofs, ...headerMerkle.proof];

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

    // 3) Balance witness
    const balanceWitness = {
      proofBalance,
      balanceGwei: v.container.effectiveBalance,
    };

    // 4) Call harness
    await verifier.TEST_verifyValidatorWCActiveAndBalance(
      beaconRootData,
      validatorWitness,
      balanceWitness,
      [],
      validatorIndex,
      expectedWC,
    );

    // 7) Verify: inclusion up to EIP-4788 + activity checks + WC match
    // await verifier.TEST_verifyValidatorWCActiveAndBalance(w, expectedWC);

    // 8) Negative: wrong WC must fail
    const wrongWC = "0x" + "11".repeat(32);
    await expect(
      verifier.TEST_verifyValidatorWCActiveAndBalance(
        beaconRootData,
        validatorWitness,
        balanceWitness,
        [],
        validatorIndex,
        wrongWC,
      ),
    ).to.be.reverted;
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
    await sszMerkleTree.addBalancesLeaf(v.container.effectiveBalance);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200; // epoch = 100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    // validator[i] -> validators_root -> state_root'
    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    // balances[i] -> balances_root -> state_root'
    const balance_proofs = await sszMerkleTree.getBalanceProof(firstBalanceLeafIndex + BigInt(validatorIndex));

    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const proofBalance = [...balance_proofs, ...headerMerkle.proof];

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

    const balanceWitness = {
      proofBalance,
      balanceGwei: v.container.effectiveBalance,
    };

    await expect(
      verifier.TEST_verifyValidatorWCActiveAndBalance(
        beaconRootData,
        validatorWitness,
        balanceWitness,
        [],
        validatorIndex,
        expectedWC,
      ),
    ).to.not.be.rejected;
  });

  it("reverts with ValidatorIsNotActivated when activationEpoch > epoch(slot)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 101n; // > epoch(slot=3200)=100
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);
    await sszMerkleTree.addBalancesLeaf(v.container.effectiveBalance);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200;
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const balance_proofs = await sszMerkleTree.getBalanceProof(firstBalanceLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const proofBalance = [...balance_proofs, ...headerMerkle.proof];

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

    const balanceWitness = {
      proofBalance,
      balanceGwei: v.container.effectiveBalance,
    };

    await expect(
      verifier.TEST_verifyValidatorWCActiveAndBalance(
        beaconRootData,
        validatorWitness,
        balanceWitness,
        [],
        validatorIndex,
        expectedWC,
      ),
    ).to.be.revertedWithCustomError(verifier, "ValidatorIsNotActivated");
  });

  it("reverts when activationEpoch == epoch(slot)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 100n; // == epoch(slot)
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);
    await sszMerkleTree.addBalancesLeaf(v.container.effectiveBalance);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const SLOT = 3200; // epoch=100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const balance_proofs = await sszMerkleTree.getBalanceProof(firstBalanceLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const proofBalance = [...balance_proofs, ...headerMerkle.proof];

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

    const balanceWitness = {
      proofBalance,
      balanceGwei: v.container.effectiveBalance,
    };

    await expect(
      verifier.TEST_verifyValidatorWCActiveAndBalance(
        beaconRootData,
        validatorWitness,
        balanceWitness,
        [],
        validatorIndex,
        expectedWC,
      ),
    ).to.be.revertedWithCustomError(verifier, "ValidatorIsNotActivated");
  });

  it("don't revert when a validator with non-FAR_FUTURE exitEpoch (proof mismatch)", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 90n;

    const SLOT = 3200; // epoch(slot) = 100
    v.container.exitEpoch = 101n; //
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);
    await sszMerkleTree.addBalancesLeaf(v.container.effectiveBalance);

    const leafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(leafCount - 1n - firstValidatorLeafIndex);

    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const balance_proofs = await sszMerkleTree.getBalanceProof(firstBalanceLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const proofBalance = [...balance_proofs, ...headerMerkle.proof];

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

    const balanceWitness = {
      proofBalance,
      balanceGwei: v.container.effectiveBalance,
    };

    await expect(
      verifier.TEST_verifyValidatorWCActiveAndBalance(
        beaconRootData,
        validatorWitness,
        balanceWitness,
        [],
        validatorIndex,
        expectedWC,
      ),
    ).to.not.be.reverted;
  });

  it("should change gIndex on pivot slot", async () => {
    const pivotSlot = 1000;
    const giPrev = randomBytes32();
    const giCurr = randomBytes32();
    const giBalancePrev = randomBytes32();
    const giBalanceCurr = randomBytes32();
    const giPendingDeposit = randomBytes32();

    const proofVerifier = await ethers.deployContract(
      "CLTopUpVerifier__Harness",
      [giPrev, giCurr, giBalancePrev, giBalanceCurr, giPendingDeposit, giPendingDeposit, pivotSlot],
      {},
    );
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot - 1)).to.equal(giPrev);
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot)).to.equal(giCurr);
    expect(await proofVerifier.TEST_getValidatorGI(0n, pivotSlot + 1)).to.equal(giCurr);
  });

  it("verifies pending deposit inclusion under the same EIP-4788 anchor", async () => {
    const v = generateValidator();
    const FAR_FUTURE = (1n << 64n) - 1n;

    v.container.slashed = false;
    v.container.activationEligibilityEpoch = 1n;
    v.container.activationEpoch = 2n;
    v.container.exitEpoch = FAR_FUTURE;
    v.container.withdrawableEpoch = FAR_FUTURE;

    const expectedWC = v.container.withdrawalCredentials;

    await sszMerkleTree.addValidatorsLeaf(v.container);
    await sszMerkleTree.addBalancesLeaf(v.container.effectiveBalance);

    const validatorsLeafCount = await sszMerkleTree.validatorsLeafCount();
    const validatorIndex = Number(validatorsLeafCount - 1n - firstValidatorLeafIndex);

    const PENDING_SLOT = 1234n;
    const PENDING_AMOUNT = parseUnits(randomInt(320).toString(), "gwei");
    const PENDING_SIGNATURE = "0x" + "11".repeat(96);

    const pendingDeposit = {
      pubkey: v.container.pubkey,
      withdrawalCredentials: v.container.withdrawalCredentials,
      amount: PENDING_AMOUNT,
      signature: PENDING_SIGNATURE,
      slot: Number(PENDING_SLOT),
    };

    await sszMerkleTree.addPendingDepositLeaf(pendingDeposit);

    const pendingLeafCount = await sszMerkleTree.pendingDepositsLeafCount();
    const pendingIndex = Number(pendingLeafCount - 1n - firstPendingDepositLeafIndex);

    const SLOT = 3200; // epoch = 100
    const stateRoot = await sszMerkleTree.getStateRoot();
    const header = await generateBeaconHeader(stateRoot, SLOT);
    const headerHash = await sszMerkleTree.beaconBlockHeaderHashTreeRoot(header);
    const childBlockTimestamp = await setBeaconBlockRoot(headerHash);

    const validator_proofs = await sszMerkleTree.getValidatorProof(firstValidatorLeafIndex + BigInt(validatorIndex));
    const balance_proofs = await sszMerkleTree.getBalanceProof(firstBalanceLeafIndex + BigInt(validatorIndex));
    const headerMerkle = await sszMerkleTree.getBeaconBlockHeaderProof(header);

    const proofValidator = [...validator_proofs, ...headerMerkle.proof];
    const proofBalance = [...balance_proofs, ...headerMerkle.proof];

    const pending_proofs = await sszMerkleTree.getPendingDepositProof(
      firstPendingDepositLeafIndex + BigInt(pendingIndex),
    );
    const proofPending = [...pending_proofs, ...headerMerkle.proof];

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

    const balanceWitness = {
      proofBalance,
      balanceGwei: v.container.effectiveBalance,
    };

    const pendingWitness = [
      {
        proof: proofPending,
        signature: PENDING_SIGNATURE,
        amount: PENDING_AMOUNT,
        slot: PENDING_SLOT,
        index: pendingIndex,
      },
    ];

    await expect(
      verifier.TEST_verifyValidatorWCActiveAndBalance(
        beaconRootData,
        validatorWitness,
        balanceWitness,
        pendingWitness,
        validatorIndex,
        expectedWC,
      ),
    ).to.not.be.reverted;
  });

  const randomInt = (max: number): number => Math.floor(Math.random() * max);

  // TODO: add test on wrong proofs revert
  // TODO: other tests to be done
});
