import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO } from "test/deploy";

// -----------------------------------------------------------------------------
// Constants & helpers
// -----------------------------------------------------------------------------

const LAST_PROCESSING_REF_SLOT = 1;

const EXIT = [
  {
    moduleId: 1,
    nodeOpId: 0,
    valIndex: 0,
    valPubkey: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  },
];

// -----------------------------------------------------------------------------
// Encoding
// -----------------------------------------------------------------------------
interface ExitRequest {
  moduleId: number;
  nodeOpId: number;
  valIndex: number;
  valPubkey: string;
}

const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
  const pubkeyHex = de0x(valPubkey);
  expect(pubkeyHex.length).to.equal(48 * 2);
  return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
};

const encodeExitRequestsDataList = (requests: ExitRequest[]) => {
  return "0x" + requests.map(encodeExitRequestHex).join("");
};

const hashExitRequest = (request: { dataFormat: number; data: string }) => {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [request.data, request.dataFormat]),
  );
};

const EXIT_DATA = { dataFormat: DATA_FORMAT_LIST, data: encodeExitRequestsDataList(EXIT) };
const EXIT_DATA_HASH = hashExitRequest(EXIT_DATA);

describe("ValidatorsExitBus: pause checks", () => {
  let oracle: ValidatorsExitBus__Harness;
  let consensus: HashConsensus__Harness;
  let admin: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let resumer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  beforeEach(async () => {
    [admin, pauser, resumer, stranger] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });

    await oracle.grantRole(await oracle.SUBMIT_REPORT_HASH_ROLE(), admin);
    await oracle.grantRole(await oracle.PAUSE_ROLE(), pauser);
    await oracle.grantRole(await oracle.RESUME_ROLE(), resumer);
  });

  it("Should not allow pauseFor call without PAUSE_ROLE", async () => {
    await expect(oracle.connect(stranger).pauseFor(60)).to.be.revertedWithOZAccessControlError(
      stranger.address,
      await oracle.PAUSE_ROLE(),
    );
  });

  it("Should not allow pauseUntil call without PAUSE_ROLE", async () => {
    await expect(oracle.connect(stranger).pauseUntil(60)).to.be.revertedWithOZAccessControlError(
      stranger.address,
      await oracle.PAUSE_ROLE(),
    );
  });

  it("pauseFor(0) → ZeroPauseDuration", async () => {
    await expect(oracle.connect(pauser).pauseFor(0)).to.be.revertedWithCustomError(oracle, "ZeroPauseDuration");
  });

  it("pauseFor blocks protected calls until resumed", async () => {
    // pause 1 h
    await oracle.connect(pauser).pauseFor(3600);

    await expect(oracle.submitExitRequestsHash(EXIT_DATA_HASH)).to.be.revertedWithCustomError(
      oracle,
      "ResumedExpected",
    );
    await expect(oracle.submitExitRequestsData(EXIT_DATA)).to.be.revertedWithCustomError(oracle, "ResumedExpected");

    await expect(oracle.triggerExits(EXIT_DATA, [0], ZeroAddress, { value: 4 })).to.be.revertedWithCustomError(
      oracle,
      "ResumedExpected",
    );

    // stranger can’t resume
    await expect(oracle.connect(stranger).resume()).to.be.revertedWithOZAccessControlError(
      stranger.address,
      await oracle.RESUME_ROLE(),
    );

    // authorised resume
    await oracle.connect(resumer).resume();

    // calls work again
    await oracle.submitExitRequestsHash(EXIT_DATA_HASH);
    await oracle.submitExitRequestsData(EXIT_DATA);
    await oracle.triggerExits(EXIT_DATA, [0], ZeroAddress, { value: 4 });
  });

  it("second pause while already paused → ResumedExpected", async () => {
    await oracle.connect(pauser).pauseFor(100);
    await expect(oracle.connect(pauser).pauseFor(100)).to.be.revertedWithCustomError(oracle, "ResumedExpected");
  });

  it("resume when not paused → PausedExpected", async () => {
    await expect(oracle.connect(resumer).resume()).to.be.revertedWithCustomError(oracle, "PausedExpected");
  });

  it("pauseUntil blocks only until the timestamp", async () => {
    const until = 5692495050;

    await oracle.connect(pauser).pauseUntil(until);

    await expect(oracle.submitExitRequestsHash(EXIT_DATA_HASH)).to.be.revertedWithCustomError(
      oracle,
      "ResumedExpected",
    );
    await expect(oracle.submitExitRequestsData(EXIT_DATA)).to.be.revertedWithCustomError(oracle, "ResumedExpected");

    await expect(oracle.triggerExits(EXIT_DATA, [0], ZeroAddress, { value: 4 })).to.be.revertedWithCustomError(
      oracle,
      "ResumedExpected",
    );
  });
});
