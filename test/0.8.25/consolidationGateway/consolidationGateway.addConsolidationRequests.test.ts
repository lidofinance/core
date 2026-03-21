import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ConsolidationGateway,
  DepositSecurityModule__MockForConsolidationGateway,
  Lido__MockForConsolidationGateway,
  WithdrawalVault__MockForConsolidationGateway,
} from "typechain-types";

import { addressToWC, advanceChainTime, generateValidator, prepareLocalMerkleTree } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
];

const ZERO_ADDRESS = ethers.ZeroAddress;

const witnessesForTargets = (targets: string[]) =>
  targets.map((pubkey) => ({
    proof: [],
    pubkey,
    validatorIndex: 0,
    childBlockTimestamp: 0,
    slot: 0,
    proposerIndex: 0,
  }));

// Helper functions
const grantConsolidationRequestRole = async (
  consolidationGateway: ConsolidationGateway,
  account: HardhatEthersSigner,
) => {
  const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();
  await consolidationGateway.grantRole(role, account);
};

const grantLimitManagerRole = async (consolidationGateway: ConsolidationGateway, account: HardhatEthersSigner) => {
  const role = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();
  await consolidationGateway.grantRole(role, account);
};

const setConsolidationLimit = async (
  consolidationGateway: ConsolidationGateway,
  signer: HardhatEthersSigner,
  maxRequests: number,
  requestsPerFrame: number,
  frameDuration: number,
) => {
  return consolidationGateway
    .connect(signer)
    .setConsolidationRequestLimit(maxRequests, requestsPerFrame, frameDuration);
};

const expectLimitData = async (
  consolidationGateway: ConsolidationGateway,
  expectedMaxRequests: number,
  expectedPerFrame: number,
  expectedFrameDuration: number,
  expectedPrevLimit: number,
  expectedCurrentLimit: number | typeof ethers.MaxUint256,
) => {
  const data = await consolidationGateway.getConsolidationRequestLimitFullInfo();
  expect(data[0]).to.equal(expectedMaxRequests); // maxConsolidationRequestsLimit
  expect(data[1]).to.equal(expectedPerFrame); // consolidationsPerFrame
  expect(data[2]).to.equal(expectedFrameDuration); // frameDurationInSec
  expect(data[3]).to.equal(expectedPrevLimit); // prevConsolidationRequestsLimit
  expect(data[4]).to.equal(expectedCurrentLimit); // currentConsolidationRequestsLimit
};

describe("ConsolidationGateway.sol: addConsolidationRequests", () => {
  let consolidationGateway: ConsolidationGateway;
  let withdrawalVault: WithdrawalVault__MockForConsolidationGateway;
  let dsm: DepositSecurityModule__MockForConsolidationGateway;
  let lido: Lido__MockForConsolidationGateway;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  // Pre-built valid witnesses with CL proofs for target validators
  let validWitnesses: {
    proof: string[];
    pubkey: string;
    validatorIndex: number;
    childBlockTimestamp: number;
    slot: number;
    proposerIndex: number;
  }[];
  let validatorPubkeys: string[];

  let originalState: string;

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForConsolidationGateway");
    dsm = await ethers.deployContract("DepositSecurityModule__MockForConsolidationGateway");
    lido = await ethers.deployContract("Lido__MockForConsolidationGateway");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
      depositSecurityModule: await dsm.getAddress(),
      lido: await lido.getAddress(),
    });

    // Set up merkle tree for CL proof verification
    const localMerkle = await prepareLocalMerkleTree();
    const withdrawalCredentials = addressToWC(admin.address, 1);

    // Generate 3 validators with matching withdrawal credentials
    const validators = [];
    const validatorIndices: number[] = [];
    for (let i = 0; i < 3; i++) {
      const validator = generateValidator(withdrawalCredentials);
      const { validatorIndex } = await localMerkle.addValidator(validator.container);
      validators.push(validator);
      validatorIndices.push(validatorIndex);
    }

    // Commit merkle tree to beacon block root
    const { childBlockTimestamp, beaconBlockHeader } = await localMerkle.commitChangesToBeaconRoot();

    // Build valid witnesses for all validators
    validWitnesses = [];
    validatorPubkeys = [];
    for (let i = 0; i < validators.length; i++) {
      const proof = await localMerkle.buildProof(validatorIndices[i], beaconBlockHeader);
      validWitnesses.push({
        proof,
        pubkey: String(validators[i].container.pubkey),
        validatorIndex: validatorIndices[i],
        childBlockTimestamp,
        slot: beaconBlockHeader.slot as number,
        proposerIndex: beaconBlockHeader.proposerIndex as number,
      });
      validatorPubkeys.push(String(validators[i].container.pubkey));
    }

    consolidationGateway = await ethers.deployContract("ConsolidationGateway", [
      admin,
      locatorAddr,
      100, // maxConsolidationRequestsLimit
      1, // consolidationsPerFrame
      48, // frameDurationInSec
      localMerkle.gIFirstValidator,
      localMerkle.gIFirstValidator,
      0,
      withdrawalCredentials,
    ]);

    await grantConsolidationRequestRole(consolidationGateway, authorizedEntity);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("should revert if caller does not have the ADD_CONSOLIDATION_REQUEST_ROLE", async () => {
    const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();

    await expect(
      consolidationGateway
        .connect(stranger)
        .addConsolidationRequests([[PUBKEYS[0]]], witnessesForTargets([PUBKEYS[1]]), ZERO_ADDRESS, { value: 2 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, role);
  });

  it("should revert with ZeroArgument error if msg.value == 0", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0]]], witnessesForTargets([PUBKEYS[1]]), ZERO_ADDRESS, { value: 0 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ZeroArgument")
      .withArgs("msg.value");
  });

  it("should revert with ZeroArgument error if sourcePubkeysGroups count is zero", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([], witnessesForTargets([PUBKEYS[1]]), ZERO_ADDRESS, { value: 10 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ZeroArgument")
      .withArgs("sourcePubkeysGroups");
  });

  it("should revert with EmptyGroup error if a source group is empty", async () => {
    // Second group is empty
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0]], []], witnessesForTargets([PUBKEYS[1], PUBKEYS[2]]), ZERO_ADDRESS, {
          value: 10,
        }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "EmptyGroup")
      .withArgs(1);
  });

  it("should revert with EmptyGroup at first index if first group is empty", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[], [PUBKEYS[0]]], witnessesForTargets([PUBKEYS[1], PUBKEYS[2]]), ZERO_ADDRESS, {
          value: 10,
        }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "EmptyGroup")
      .withArgs(0);
  });

  it("should revert with ArraysLengthMismatch error if arrays have different lengths", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0]]], witnessesForTargets([PUBKEYS[1], PUBKEYS[2]]), ZERO_ADDRESS, {
          value: 10,
        }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ArraysLengthMismatch")
      .withArgs(1, 2);
  });

  it("should revert with DSMDepositsPaused error if DSM deposits are paused", async () => {
    await dsm.mock__setDepositsPaused(true);

    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], ZERO_ADDRESS, { value: 2 }),
    ).to.be.revertedWithCustomError(consolidationGateway, "DSMDepositsPaused");
  });

  it("should revert with LidoDepositsPaused error if Lido deposits are paused", async () => {
    await lido.mock__setCanDeposit(false);

    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], ZERO_ADDRESS, { value: 2 }),
    ).to.be.revertedWithCustomError(consolidationGateway, "LidoDepositsPaused");
  });

  it("should not revert when DSM deposits are not paused and Lido deposits are enabled", async () => {
    await dsm.mock__setDepositsPaused(false);
    await lido.mock__setCanDeposit(true);

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], ZERO_ADDRESS, { value: 2 });

    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled");
  });

  it("should revert if total fee value sent is insufficient to cover all provided consolidation requests", async () => {
    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0], PUBKEYS[1]]], [validWitnesses[0]], ZERO_ADDRESS, {
          value: 1,
        }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "InsufficientFee")
      .withArgs(2, 1);
  });

  it("should not allow to set limit without EXIT_LIMIT_MANAGER_ROLE", async () => {
    const limitManagerRole = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();

    await expect(consolidationGateway.connect(stranger).setConsolidationRequestLimit(4, 1, 48))
      .to.be.revertedWithCustomError(consolidationGateway, "AccessControlUnauthorizedAccount")
      .withArgs(await stranger.getAddress(), limitManagerRole);
  });

  it("should set consolidation limit", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);

    const limitTx = await setConsolidationLimit(consolidationGateway, authorizedEntity, 4, 1, 48);
    await expect(limitTx).to.emit(consolidationGateway, "ConsolidationRequestsLimitSet").withArgs(4, 1, 48);
  });

  it("should trigger consolidation request", async () => {
    // Grouped: [source0, source1] -> target0, i.e. two sources to one target
    const sourcePubkeysGroups = [[PUBKEYS[0], PUBKEYS[1]]];

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests(sourcePubkeysGroups, [validWitnesses[0]], ZERO_ADDRESS, { value: 3 });

    // Check that the withdrawal vault was called with expanded flat pairs
    const flatSources = [PUBKEYS[0], PUBKEYS[1]];
    const flatTargets = [validatorPubkeys[0], validatorPubkeys[0]];
    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled").withArgs(flatSources, flatTargets);
  });

  it("should check current consolidation limit", async () => {
    await expectLimitData(consolidationGateway, 100, 1, 48, 100, 100);

    // 2 total requests: [source0, source1] -> target0
    const sourcePubkeysGroups = [[PUBKEYS[0], PUBKEYS[1]]];

    await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests(sourcePubkeysGroups, [validWitnesses[0]], ZERO_ADDRESS, { value: 3 });

    await expectLimitData(consolidationGateway, 100, 1, 48, 98, 98);

    await advanceChainTime(48n);

    await expectLimitData(consolidationGateway, 100, 1, 48, 98, 99);
  });

  it("should revert if limit doesn't cover requests count", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);
    await setConsolidationLimit(consolidationGateway, authorizedEntity, 2, 1, 48);

    // 3 total requests across groups
    const sourcePubkeysGroups = [[PUBKEYS[0], PUBKEYS[1]], [PUBKEYS[2]]];

    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests(sourcePubkeysGroups, [validWitnesses[0], validWitnesses[1]], ZERO_ADDRESS, {
          value: 4,
        }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded")
      .withArgs(3, 2);
  });

  it("should trigger consolidation request as limit is enough for processing all requests", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);
    await setConsolidationLimit(consolidationGateway, authorizedEntity, 3, 1, 48);

    // 3 total requests: [source0, source1] -> target0, [source2] -> target1
    const sourcePubkeysGroups = [[PUBKEYS[0], PUBKEYS[1]], [PUBKEYS[2]]];
    const witnesses = [validWitnesses[0], validWitnesses[1]];

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests(sourcePubkeysGroups, witnesses, ZERO_ADDRESS, { value: 4 });

    // Check that the withdrawal vault was called with expanded flat pairs
    const flatSources = [PUBKEYS[0], PUBKEYS[1], PUBKEYS[2]];
    const flatTargets = [validatorPubkeys[0], validatorPubkeys[0], validatorPubkeys[1]];
    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled").withArgs(flatSources, flatTargets);

    await expect(
      consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests(sourcePubkeysGroups, witnesses, ZERO_ADDRESS, { value: 4 }),
    )
      .to.be.revertedWithCustomError(consolidationGateway, "ConsolidationRequestsLimitExceeded")
      .withArgs(3, 0);

    await advanceChainTime(48n * 3n);

    await expect(tx).to.emit(withdrawalVault, "AddConsolidationRequestsCalled").withArgs(flatSources, flatTargets);
  });

  it("should refund fee to recipient address", async () => {
    const prevBalance = await ethers.provider.getBalance(stranger);

    await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], stranger, { value: 1 + 7 });

    const newBalance = await ethers.provider.getBalance(stranger);

    expect(newBalance).to.equal(prevBalance + 7n);
  });

  it("should refund fee to sender address when refundRecipient is zero", async () => {
    const SENDER_ADDR = authorizedEntity.address;
    const prevBalance = await ethers.provider.getBalance(SENDER_ADDR);

    const tx = await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], ZERO_ADDRESS, { value: 1 + 7 });

    const receipt = await tx.wait();
    const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

    const newBalance = await ethers.provider.getBalance(SENDER_ADDR);
    expect(newBalance).to.equal(prevBalance - gasUsed - 1n);
  });

  it("preserves eth balance when calling addConsolidationRequests", async () => {
    const balanceBefore = await ethers.provider.getBalance(consolidationGateway);

    await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], ZERO_ADDRESS, { value: 2 });

    const balanceAfter = await ethers.provider.getBalance(consolidationGateway);
    expect(balanceAfter).to.equal(balanceBefore);
  });

  it("should not make refund if refund is zero", async () => {
    const recipientBalanceBefore = await ethers.provider.getBalance(stranger);

    await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], stranger, { value: 1 });

    const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore);
  });

  it("should refund ETH if refund > 0", async () => {
    const recipientBalanceBefore = await ethers.provider.getBalance(stranger);

    await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], stranger, { value: 5 });

    const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
    expect(recipientBalanceAfter).to.equal(recipientBalanceBefore + 4n); // 5 - 1 fee = 4 refund
  });

  it("should set maxConsolidationRequestsLimit to 0 and return currentConsolidationRequestsLimit as type(uint256).max", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);

    await setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 0, 48);

    await expectLimitData(consolidationGateway, 0, 0, 48, 0, ethers.MaxUint256);
  });

  it("should allow unlimited consolidation requests when limit is 0", async () => {
    // 10 total requests grouped into pairs
    const sourcePubkeysGroups = Array(10)
      .fill(0)
      .map((_, i) => [PUBKEYS[i % 3]]);
    const witnesses = Array(10)
      .fill(0)
      .map((_, i) => validWitnesses[(i + 1) % 3]);

    // Should not revert even with many requests when limit is 0 (unlimited)
    await consolidationGateway
      .connect(authorizedEntity)
      .addConsolidationRequests(sourcePubkeysGroups, witnesses, ZERO_ADDRESS, { value: 15 });
  });

  it("should not allow to set consolidationsPerFrame bigger than maxConsolidationRequestsLimit", async () => {
    await grantLimitManagerRole(consolidationGateway, authorizedEntity);

    await expect(setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 1, 48)).to.be.revertedWithCustomError(
      consolidationGateway,
      "TooLargeItemsPerFrame",
    );
  });
});
