import { expect } from "chai";
import { ZeroHash } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { ValidatorsExitBus__Harness } from "typechain-types";

import { VEBO_CONSENSUS_VERSION } from "lib";

import { deployVEBO, initVEBO } from "test/deploy";
import { Snapshot } from "test/suite";

describe("ValidatorsExitBusOracle.sol:finalizeUpgrade_v4", () => {
  let oracle: ValidatorsExitBus__Harness;
  let admin: HardhatEthersSigner;

  let originalState: string;

  const NEW_CONSENSUS_VERSION = VEBO_CONSENSUS_VERSION + 1n;

  const EXIT_BALANCE_LIMIT_SLOT = ethers.keccak256(ethers.toUtf8Bytes("lido.ValidatorsExitBus.exitBalanceLimitEth"));
  const MAX_VALIDATORS_PER_REPORT_SLOT = ethers.keccak256(
    ethers.toUtf8Bytes("lido.ValidatorsExitBus.maxValidatorsPerReport"),
  );
  const DATA_PROCESSING_STATE_SLOT = ethers.keccak256(
    ethers.toUtf8Bytes("lido.ValidatorsExitBusOracle.dataProcessingState"),
  );

  before(async () => {
    [admin] = await ethers.getSigners();

    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;

    await initVEBO({ admin: admin.address, oracle, consensus: deployed.consensus });

    // emulate the proxy state before the upgrade: v3 storage
    await oracle.setContractVersion(3);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("should finalize upgrade from v3 to v4", async () => {
    expect(await oracle.getContractVersion()).to.equal(3);

    const tx = await oracle.finalizeUpgrade_v4(NEW_CONSENSUS_VERSION);

    await expect(tx).to.emit(oracle, "ContractVersionSet").withArgs(4);
    await expect(tx).to.emit(oracle, "ConsensusVersionSet").withArgs(NEW_CONSENSUS_VERSION, VEBO_CONSENSUS_VERSION);

    expect(await oracle.getContractVersion()).to.equal(4);
    expect(await oracle.getConsensusVersion()).to.equal(NEW_CONSENSUS_VERSION);
  });

  it("should clear the deprecated storage slots", async () => {
    // emulate v3 state: the slots hold stale limit config and processing state
    const nonZero = ethers.zeroPadValue("0x01", 32);
    const oracleAddress = await oracle.getAddress();
    await ethers.provider.send("hardhat_setStorageAt", [oracleAddress, EXIT_BALANCE_LIMIT_SLOT, nonZero]);
    await ethers.provider.send("hardhat_setStorageAt", [oracleAddress, MAX_VALIDATORS_PER_REPORT_SLOT, nonZero]);
    await ethers.provider.send("hardhat_setStorageAt", [oracleAddress, DATA_PROCESSING_STATE_SLOT, nonZero]);
    expect(await ethers.provider.getStorage(oracleAddress, EXIT_BALANCE_LIMIT_SLOT)).to.equal(nonZero);
    expect(await ethers.provider.getStorage(oracleAddress, MAX_VALIDATORS_PER_REPORT_SLOT)).to.equal(nonZero);
    expect(await ethers.provider.getStorage(oracleAddress, DATA_PROCESSING_STATE_SLOT)).to.equal(nonZero);

    await oracle.finalizeUpgrade_v4(NEW_CONSENSUS_VERSION);

    expect(await ethers.provider.getStorage(oracleAddress, EXIT_BALANCE_LIMIT_SLOT)).to.equal(ZeroHash);
    expect(await ethers.provider.getStorage(oracleAddress, MAX_VALIDATORS_PER_REPORT_SLOT)).to.equal(ZeroHash);
    expect(await ethers.provider.getStorage(oracleAddress, DATA_PROCESSING_STATE_SLOT)).to.equal(ZeroHash);
  });

  it("should revert on a second call", async () => {
    await oracle.finalizeUpgrade_v4(NEW_CONSENSUS_VERSION);

    await expect(oracle.finalizeUpgrade_v4(NEW_CONSENSUS_VERSION + 1n)).to.be.revertedWithCustomError(
      oracle,
      "InvalidContractVersionIncrement",
    );
  });

  it("should revert if the contract is not v3", async () => {
    await oracle.setContractVersion(2);

    await expect(oracle.finalizeUpgrade_v4(NEW_CONSENSUS_VERSION)).to.be.revertedWithCustomError(
      oracle,
      "InvalidContractVersionIncrement",
    );
  });

  it("should revert if the consensus version is not changed", async () => {
    await expect(oracle.finalizeUpgrade_v4(VEBO_CONSENSUS_VERSION)).to.be.revertedWithCustomError(
      oracle,
      "VersionCannotBeSame",
    );
  });
});
