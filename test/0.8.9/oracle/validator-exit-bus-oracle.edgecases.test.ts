import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  HashConsensus__Harness,
  StakingModule__MockBadKeys,
  StakingRouter__MockForValidatorsExitBus,
  ValidatorsExitBus__Harness,
} from "typechain-types";

import { GENESIS_TIME, numberToHex, SECONDS_PER_SLOT } from "lib";

import {
  DATA_FORMAT_LIST,
  DATA_FORMAT_LIST_WITH_KEY_INDEX,
  deployLidoLocator,
  deployVEBO,
  initVEBO,
  makeMockPubkey,
} from "test/deploy";

const PUBKEY_AA = "0x" + "aa".repeat(48);
const PUBKEY_BB = "0x" + "bb".repeat(48);

const encodeV1 = (moduleId: number, nodeOpId: number, valIndex: number, pubkey: string) =>
  ("0x" +
    numberToHex(moduleId, 3) +
    numberToHex(nodeOpId, 5) +
    numberToHex(valIndex, 8) +
    pubkey.slice(2)) as `0x${string}`;

const encodeV2 = (moduleId: number, nodeOpId: number, valIndex: number, keyIndex: number, pubkey: string) =>
  ("0x" +
    numberToHex(moduleId, 3) +
    numberToHex(nodeOpId, 5) +
    numberToHex(valIndex, 8) +
    numberToHex(keyIndex, 8) +
    pubkey.slice(2)) as `0x${string}`;

describe("ValidatorsExitBusOracle.sol:edge coverage", () => {
  let oracle: ValidatorsExitBus__Harness;
  let stakingRouter: StakingRouter__MockForValidatorsExitBus;
  let consensus: HashConsensus__Harness;
  let admin: HardhatEthersSigner;

  beforeEach(async () => {
    [admin] = await ethers.getSigners();
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle as ValidatorsExitBus__Harness;
    stakingRouter = deployed.stakingRouter as StakingRouter__MockForValidatorsExitBus;
    consensus = deployed.consensus as HashConsensus__Harness;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: 0,
    });
  });

  it("constructor: rejects invalid MaxEB weights", async () => {
    const locator = await deployLidoLocator();
    const factory = await ethers.getContractFactory("ValidatorsExitBus__Harness");
    await expect(
      ethers.deployContract("ValidatorsExitBus__Harness", [
        SECONDS_PER_SLOT,
        GENESIS_TIME,
        await locator.getAddress(),
        0n,
        32n,
      ]),
    ).to.be.revertedWithCustomError(factory, "InvalidMaxEBWeight");
  });

  it("unpackExitRequest happy path + bounds", async () => {
    const request = encodeV1(1, 2, 3, PUBKEY_AA);

    const [pubkey, nodeOpId, moduleId, valIndex] = await oracle.unpackExitRequest(request, DATA_FORMAT_LIST, 0);
    expect(pubkey).to.equal(PUBKEY_AA);
    expect(nodeOpId).to.equal(2n);
    expect(moduleId).to.equal(1n);
    expect(valIndex).to.equal(3n);

    await expect(oracle.unpackExitRequest(request, DATA_FORMAT_LIST, 1)).to.be.revertedWithCustomError(
      oracle,
      "ExitDataIndexOutOfRange",
    );
  });

  it("base _getTimestamp is reachable", async () => {
    const ts = await oracle.callBaseTimestamp();
    expect(ts).to.be.greaterThan(0);
  });

  it("unsupported formats revert in decoder, dispatcher, and balance calc", async () => {
    const request = encodeV1(1, 1, 1, PUBKEY_AA);

    await expect(oracle.callGetValidatorData(request, 3, 0)).to.be.revertedWithCustomError(
      oracle,
      "UnsupportedRequestsDataFormat",
    );
    await expect(oracle.callProcessExitRequestsList(request, 3)).to.be.revertedWithCustomError(
      oracle,
      "UnsupportedRequestsDataFormat",
    );
    await expect(oracle.calculateTotalExitBalanceEth(request, 3)).to.be.revertedWithCustomError(
      oracle,
      "UnsupportedRequestsDataFormat",
    );
  });

  it("processExitRequestsList supports format 2 and reverts on unsorted data", async () => {
    const req1 = encodeV2(1, 1, 2, 0, makeMockPubkey(1, 0)); // valIndex 2
    const req2 = encodeV2(1, 1, 1, 1, makeMockPubkey(1, 1)); // valIndex 1 (unordered)
    const data = (req1 + req2.slice(2)) as `0x${string}`;

    await expect(
      oracle.callProcessExitRequestsList(data, DATA_FORMAT_LIST_WITH_KEY_INDEX),
    ).to.be.revertedWithCustomError(oracle, "InvalidRequestsDataSortOrder");
  });

  it("calculateTotalExitBalanceEth reverts on unexpected WC type", async () => {
    await stakingRouter.setStakingModuleWithdrawalCredentialsType(30, 0x03); // unsupported
    const req = encodeV1(30, 1, 1, PUBKEY_AA);

    await expect(oracle.calculateTotalExitBalanceEth(req, DATA_FORMAT_LIST)).to.be.revertedWithCustomError(
      oracle,
      "UnexpectedWCType",
    );
  });

  it("verifyKey detects invalid lengths and mismatched pubkeys", async () => {
    const badModule = (await ethers.deployContract("StakingModule__MockBadKeys")) as StakingModule__MockBadKeys;
    await stakingRouter.setStakingModuleWithdrawalCredentialsType(40, 0x01);
    await stakingRouter.setStakingModuleAddress(40, await badModule.getAddress());

    // invalid length (empty)
    await badModule.setReturned("0x");
    const req = encodeV2(40, 1, 1, 0, PUBKEY_AA);
    await expect(
      oracle.callProcessExitRequestsList(req, DATA_FORMAT_LIST_WITH_KEY_INDEX),
    ).to.be.revertedWithCustomError(oracle, "InvalidRetrievedKeyLength");

    // mismatched pubkey (returns PUBKEY_BB but request has PUBKEY_AA)
    await badModule.setReturned(PUBKEY_BB);
    await expect(
      oracle.callProcessExitRequestsList(req, DATA_FORMAT_LIST_WITH_KEY_INDEX),
    ).to.be.revertedWithCustomError(oracle, "InvalidPublicKey");
  });
});
