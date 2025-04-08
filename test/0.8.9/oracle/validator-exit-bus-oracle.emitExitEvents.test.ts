import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { HashConsensus__Harness, ValidatorsExitBus__Harness, WithdrawalVault__MockForVebo } from "typechain-types";

import { de0x, numberToHex } from "lib";

import { DATA_FORMAT_LIST, deployVEBO, initVEBO } from "test/deploy";

const PUBKEYS = [
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
];

describe("ValidatorsExitBusOracle.sol:emitExitEvents", () => {
  let consensus: HashConsensus__Harness;
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;
  let withdrawalVault: WithdrawalVault__MockForVebo;

  let exitRequests: ExitRequest[];
  let exitRequestHash: string;
  let exitRequest: ExitRequestData;
  let authorizedEntity: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  const LAST_PROCESSING_REF_SLOT = 1;

  interface ExitRequest {
    moduleId: number;
    nodeOpId: number;
    valIndex: number;
    valPubkey: string;
  }

  interface ExitRequestData {
    dataFormat: number;
    data: string;
  }

  const encodeExitRequestHex = ({ moduleId, nodeOpId, valIndex, valPubkey }: ExitRequest) => {
    const pubkeyHex = de0x(valPubkey);
    expect(pubkeyHex.length).to.equal(48 * 2);
    return numberToHex(moduleId, 3) + numberToHex(nodeOpId, 5) + numberToHex(valIndex, 8) + pubkeyHex;
  };

  const encodeExitRequestsDataList = (requests: ExitRequest[]) => {
    return "0x" + requests.map(encodeExitRequestHex).join("");
  };

  const deploy = async () => {
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    consensus = deployed.consensus;
    withdrawalVault = deployed.withdrawalVault;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus,
      withdrawalVault,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: LAST_PROCESSING_REF_SLOT,
    });

    oracleVersion = await oracle.getContractVersion();
  };

  before(async () => {
    [admin, authorizedEntity, stranger] = await ethers.getSigners();

    await deploy();
  });

  it("Initially, report was not submitted", async () => {
    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
    ];

    exitRequest = {
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(exitRequests),
    };

    await expect(oracle.emitExitEvents(exitRequest, 2))
      .to.be.revertedWithCustomError(oracle, "ExitHashWasNotSubmitted")
      .withArgs();
  });

  it("Wrong contract version", async () => {
    await expect(oracle.emitExitEvents(exitRequest, 1))
      .to.be.revertedWithCustomError(oracle, "UnexpectedContractVersion")
      .withArgs(2, 1);
  });

  it("Should revert without SUBMIT_REPORT_HASH_ROLE role", async () => {
    const request = [exitRequest.data, exitRequest.dataFormat];
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["(bytes, uint256)"], [request]));

    await expect(oracle.connect(stranger).submitReportHash(hash)).to.be.revertedWithOZAccessControlError(
      await stranger.getAddress(),
      await oracle.SUBMIT_REPORT_HASH_ROLE(),
    );
  });

  it("Should store exit hash for authorized entity", async () => {
    const role = await oracle.SUBMIT_REPORT_HASH_ROLE();

    await oracle.grantRole(role, authorizedEntity);

    exitRequestHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [exitRequest.data, exitRequest.dataFormat]),
    );

    const submitTx = await oracle.connect(authorizedEntity).submitReportHash(exitRequestHash);

    await expect(submitTx).to.emit(oracle, "StoredExitRequestHash").withArgs(exitRequestHash);
  });

  it("Emit ValidatorExit event", async () => {
    const emitTx = await oracle.emitExitEvents(exitRequest, 2);
    const block = await emitTx.getBlock();

    await expect(emitTx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[0].moduleId,
        exitRequests[0].nodeOpId,
        exitRequests[0].valIndex,
        exitRequests[0].valPubkey,
        block?.timestamp,
      );

    await expect(emitTx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[1].moduleId,
        exitRequests[1].nodeOpId,
        exitRequests[1].valIndex,
        exitRequests[1].valPubkey,
        block?.timestamp,
      );

    await expect(emitTx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[2].moduleId,
        exitRequests[2].nodeOpId,
        exitRequests[2].valIndex,
        exitRequests[2].valPubkey,
        block?.timestamp,
      );

    await expect(emitTx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[3].moduleId,
        exitRequests[3].nodeOpId,
        exitRequests[3].valIndex,
        exitRequests[3].valPubkey,
        block?.timestamp,
      );
  });

  it("Should revert if wrong DATA_FORMAT", async () => {
    const request = [exitRequest.data, 2];
    const hash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], request));
    const submitTx = await oracle.connect(authorizedEntity).submitReportHash(hash);
    await expect(submitTx).to.emit(oracle, "StoredExitRequestHash").withArgs(hash);
    exitRequest = {
      dataFormat: 2,
      data: encodeExitRequestsDataList(exitRequests),
    };
    await expect(oracle.emitExitEvents(exitRequest, 2))
      .to.be.revertedWithCustomError(oracle, "UnsupportedRequestsDataFormat")
      .withArgs(2);
  });

  it("Should deliver part of request if limit is smaller than number of requests", async () => {
    const role = await oracle.EXIT_REPORT_LIMIT_ROLE();
    await oracle.grantRole(role, authorizedEntity);
    const exitLimitTx = await oracle.connect(authorizedEntity).setExitReportLimit(2, 1);
    await expect(exitLimitTx).to.emit(oracle, "ExitRequestsLimitSet").withArgs(2, 1);

    exitRequests = [
      { moduleId: 1, nodeOpId: 0, valIndex: 0, valPubkey: PUBKEYS[0] },
      { moduleId: 1, nodeOpId: 0, valIndex: 2, valPubkey: PUBKEYS[1] },
      { moduleId: 2, nodeOpId: 0, valIndex: 1, valPubkey: PUBKEYS[2] },
      { moduleId: 2, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[3] },
      { moduleId: 3, nodeOpId: 0, valIndex: 3, valPubkey: PUBKEYS[4] },
    ];

    exitRequest = {
      dataFormat: DATA_FORMAT_LIST,
      data: encodeExitRequestsDataList(exitRequests),
    };

    exitRequestHash = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes", "uint256"], [exitRequest.data, exitRequest.dataFormat]),
    );

    const history0 = await oracle.getDeliveryHistory(exitRequestHash);
    expect(history0.length).to.eq(0);

    const submitTx = await oracle.connect(authorizedEntity).submitReportHash(exitRequestHash);
    await expect(submitTx).to.emit(oracle, "StoredExitRequestHash");

    const emitTx = await oracle.emitExitEvents(exitRequest, 2);

    const receipt = await emitTx.wait();
    expect(receipt?.logs.length).to.eq(2);

    const block = await emitTx.getBlock();

    await expect(emitTx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[0].moduleId,
        exitRequests[0].nodeOpId,
        exitRequests[0].valIndex,
        exitRequests[0].valPubkey,
        block?.timestamp,
      );

    await expect(emitTx)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[1].moduleId,
        exitRequests[1].nodeOpId,
        exitRequests[1].valIndex,
        exitRequests[1].valPubkey,
        block?.timestamp,
      );

    const history1 = await oracle.getDeliveryHistory(exitRequestHash);
    expect(history1.length).to.eq(2);
    expect(history1[0].lastDeliveredKeyIndex).to.eq(0);
    expect(history1[1].lastDeliveredKeyIndex).to.eq(1);

    const emitTx2 = await oracle.emitExitEvents(exitRequest, 2);

    const receipt2 = await emitTx2.wait();
    expect(receipt2?.logs.length).to.eq(1);

    const block2 = await emitTx2.getBlock();

    await expect(emitTx2)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[2].moduleId,
        exitRequests[2].nodeOpId,
        exitRequests[2].valIndex,
        exitRequests[2].valPubkey,
        block2?.timestamp,
      );

    const history2 = await oracle.getDeliveryHistory(exitRequestHash);
    expect(history2.length).to.eq(3);
    expect(history2[0].lastDeliveredKeyIndex).to.eq(0);
    expect(history2[1].lastDeliveredKeyIndex).to.eq(1);
    expect(history2[2].lastDeliveredKeyIndex).to.eq(2);

    const emitTx3 = await oracle.emitExitEvents(exitRequest, 2);

    const receipt3 = await emitTx2.wait();
    expect(receipt3?.logs.length).to.eq(1);

    const block3 = await emitTx3.getBlock();

    await expect(emitTx3)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[3].moduleId,
        exitRequests[3].nodeOpId,
        exitRequests[3].valIndex,
        exitRequests[3].valPubkey,
        block3?.timestamp,
      );

    const history3 = await oracle.getDeliveryHistory(exitRequestHash);
    expect(history3.length).to.eq(4);
    expect(history3[0].lastDeliveredKeyIndex).to.eq(0);
    expect(history3[1].lastDeliveredKeyIndex).to.eq(1);
    expect(history3[2].lastDeliveredKeyIndex).to.eq(2);
    expect(history3[3].lastDeliveredKeyIndex).to.eq(3);

    const emitTx4 = await oracle.emitExitEvents(exitRequest, 2);

    const receipt4 = await emitTx2.wait();
    expect(receipt4?.logs.length).to.eq(1);

    const block4 = await emitTx4.getBlock();

    await expect(emitTx4)
      .to.emit(oracle, "ValidatorExitRequest")
      .withArgs(
        exitRequests[4].moduleId,
        exitRequests[4].nodeOpId,
        exitRequests[4].valIndex,
        exitRequests[4].valPubkey,
        block4?.timestamp,
      );

    const history4 = await oracle.getDeliveryHistory(exitRequestHash);
    expect(history4.length).to.eq(5);
    expect(history4[0].lastDeliveredKeyIndex).to.eq(0);
    expect(history4[1].lastDeliveredKeyIndex).to.eq(1);
    expect(history4[2].lastDeliveredKeyIndex).to.eq(2);
    expect(history4[3].lastDeliveredKeyIndex).to.eq(3);
    expect(history4[4].lastDeliveredKeyIndex).to.eq(4);

    await expect(oracle.emitExitEvents(exitRequest, 2)).to.be.revertedWithCustomError(
      oracle,
      "RequestsAlreadyDelivered",
    );
  });
});
