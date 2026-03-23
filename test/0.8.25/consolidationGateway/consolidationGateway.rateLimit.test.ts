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

import { PUBKEYS } from "../consolidation-helpers";

// Helper functions
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

describe("ConsolidationGateway.sol: rate limit management", () => {
  let consolidationGateway: ConsolidationGateway;
  let withdrawalVault: WithdrawalVault__MockForConsolidationGateway;
  let admin: HardhatEthersSigner;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let validWitnesses: {
    proof: string[];
    pubkey: string;
    validatorIndex: number;
    childBlockTimestamp: number;
    slot: number;
    proposerIndex: number;
  }[];

  let originalState: string;

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    const locator = await deployLidoLocator();
    const locatorAddr = await locator.getAddress();

    withdrawalVault = await ethers.deployContract("WithdrawalVault__MockForConsolidationGateway");
    const dsm: DepositSecurityModule__MockForConsolidationGateway = await ethers.deployContract(
      "DepositSecurityModule__MockForConsolidationGateway",
    );
    const lido: Lido__MockForConsolidationGateway = await ethers.deployContract("Lido__MockForConsolidationGateway");

    await updateLidoLocatorImplementation(locatorAddr, {
      withdrawalVault: await withdrawalVault.getAddress(),
      depositSecurityModule: await dsm.getAddress(),
      lido: await lido.getAddress(),
    });

    // Set up merkle tree for CL proof verification
    const localMerkle = await prepareLocalMerkleTree();
    const withdrawalCredentials = addressToWC(await withdrawalVault.getAddress(), 2);

    // Generate validators with matching withdrawal credentials
    const validators = [];
    const validatorIndices: number[] = [];
    for (let i = 0; i < 3; i++) {
      const validator = generateValidator(withdrawalCredentials);
      const { validatorIndex } = await localMerkle.addValidator(validator.container);
      validators.push(validator);
      validatorIndices.push(validatorIndex);
    }

    const { childBlockTimestamp, beaconBlockHeader } = await localMerkle.commitChangesToBeaconRoot();

    validWitnesses = [];
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
    ]);

    const role = await consolidationGateway.ADD_CONSOLIDATION_REQUEST_ROLE();
    await consolidationGateway.grantRole(role, authorizedEntity);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("setConsolidationRequestLimit", () => {
    it("should revert without EXIT_LIMIT_MANAGER_ROLE", async () => {
      const limitManagerRole = await consolidationGateway.EXIT_LIMIT_MANAGER_ROLE();

      await expect(consolidationGateway.connect(stranger).setConsolidationRequestLimit(4, 1, 48))
        .to.be.revertedWithCustomError(consolidationGateway, "AccessControlUnauthorizedAccount")
        .withArgs(await stranger.getAddress(), limitManagerRole);
    });

    it("should set consolidation limit and emit event", async () => {
      await grantLimitManagerRole(consolidationGateway, authorizedEntity);

      const limitTx = await setConsolidationLimit(consolidationGateway, authorizedEntity, 4, 1, 48);
      await expect(limitTx).to.emit(consolidationGateway, "ConsolidationRequestsLimitSet").withArgs(4, 1, 48);
    });

    it("should revert if consolidationsPerFrame bigger than maxConsolidationRequestsLimit", async () => {
      await grantLimitManagerRole(consolidationGateway, authorizedEntity);

      await expect(
        setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 1, 48),
      ).to.be.revertedWithCustomError(consolidationGateway, "TooLargeItemsPerFrame");
    });

    it("should update limit config values", async () => {
      await grantLimitManagerRole(consolidationGateway, authorizedEntity);

      await setConsolidationLimit(consolidationGateway, authorizedEntity, 50, 5, 100);

      await expectLimitData(consolidationGateway, 50, 5, 100, 50, 50);
    });

    it("should allow decreasing limit mid-usage", async () => {
      await grantLimitManagerRole(consolidationGateway, authorizedEntity);

      // Consume some limit
      await consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0]]], [validWitnesses[0]], ethers.ZeroAddress, { value: 2 });

      // Decrease limit — should succeed
      await setConsolidationLimit(consolidationGateway, authorizedEntity, 10, 1, 48);
      await expectLimitData(consolidationGateway, 10, 1, 48, 10, 10);
    });
  });

  context("getConsolidationRequestLimitFullInfo", () => {
    it("should return initial limit data", async () => {
      await expectLimitData(consolidationGateway, 100, 1, 48, 100, 100);
    });

    it("should reflect limit consumption after requests", async () => {
      // 2 total requests: [source0, source1] -> target0
      const sourcePubkeysGroups = [[PUBKEYS[0], PUBKEYS[1]]];

      await consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests(sourcePubkeysGroups, [validWitnesses[0]], ethers.ZeroAddress, { value: 3 });

      await expectLimitData(consolidationGateway, 100, 1, 48, 98, 98);
    });

    it("should restore limit after frame advancement", async () => {
      // Consume 2
      await consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests([[PUBKEYS[0], PUBKEYS[1]]], [validWitnesses[0]], ethers.ZeroAddress, { value: 3 });

      await expectLimitData(consolidationGateway, 100, 1, 48, 98, 98);

      // Advance one frame → restores 1
      await advanceChainTime(48n);
      await expectLimitData(consolidationGateway, 100, 1, 48, 98, 99);

      // Advance another frame → restores another 1
      await advanceChainTime(48n);
      await expectLimitData(consolidationGateway, 100, 1, 48, 98, 100);
    });

    it("should return currentConsolidationRequestsLimit as MaxUint256 when limit is 0 (unlimited)", async () => {
      await grantLimitManagerRole(consolidationGateway, authorizedEntity);

      await setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 0, 48);

      await expectLimitData(consolidationGateway, 0, 0, 48, 0, ethers.MaxUint256);
    });

    it("should allow unlimited consolidation requests when limit is 0", async () => {
      // Default limit is 100, but limit 0 means unlimited — deploy with 0
      await grantLimitManagerRole(consolidationGateway, authorizedEntity);
      await setConsolidationLimit(consolidationGateway, authorizedEntity, 0, 0, 48);

      // 3 total requests grouped into pairs
      const sourcePubkeysGroups = Array(3)
        .fill(0)
        .map((_, i) => [PUBKEYS[i % 3]]);
      const witnesses = Array(3)
        .fill(0)
        .map((_, i) => validWitnesses[i % 3]);

      // Should not revert even with many requests when limit is 0 (unlimited)
      await consolidationGateway
        .connect(authorizedEntity)
        .addConsolidationRequests(sourcePubkeysGroups, witnesses, ethers.ZeroAddress, { value: 10 });
    });
  });
});
