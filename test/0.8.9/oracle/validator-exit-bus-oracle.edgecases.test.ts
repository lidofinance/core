import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  OracleReportSanityChecker__MockForExitBusWeights,
  StakingModule__MockBadKeys,
  StakingRouter__MockForValidatorsExitBus,
  ValidatorsExitBus__Harness,
} from "typechain-types";

import { deployVEBO, encodeWithdrawalRequests, initVEBO, updateLidoLocatorImplementation } from "test/deploy";

const PUBKEY_AA = "0x" + "aa".repeat(48);

const fwr = (moduleId: number) => encodeWithdrawalRequests([{ moduleId, nodeOpId: 1, keyIndex: 1, amount: 0n }]);

describe("ValidatorsExitBusOracle.sol:edge coverage", () => {
  let oracle: ValidatorsExitBus__Harness;
  let stakingRouter: StakingRouter__MockForValidatorsExitBus;
  let admin: HardhatEthersSigner;
  let locatorAddr: string;

  beforeEach(async () => {
    [admin] = await ethers.getSigners();
    const deployed = await deployVEBO(admin.address);
    oracle = deployed.oracle;
    stakingRouter = deployed.stakingRouter;
    locatorAddr = deployed.locatorAddr;

    await initVEBO({
      admin: admin.address,
      oracle,
      consensus: deployed.consensus,
      resumeAfterDeploy: true,
      lastProcessingRefSlot: 0,
    });
  });

  it("reverts on unexpected WC type", async () => {
    await stakingRouter.setStakingModuleWithdrawalCredentialsType(30, 0x03); // unsupported

    await expect(oracle.processWithdrawalRequests(fwr(30))).to.be.revertedWithCustomError(oracle, "UnexpectedWCType");
  });

  context("max effective balance weights", () => {
    const useSanityCheckerWeights = async (weightType1: bigint, weightType2: bigint) => {
      const mockSanity = (await ethers.deployContract("OracleReportSanityChecker__MockForExitBusWeights", [
        weightType1,
        weightType2,
      ])) as OracleReportSanityChecker__MockForExitBusWeights;

      await updateLidoLocatorImplementation(locatorAddr, {
        oracleReportSanityChecker: await mockSanity.getAddress(),
      });
    };

    it("InvalidMaxEBWeight when sanity checker returns zero", async () => {
      await useSanityCheckerWeights(0n, 32n);

      await expect(oracle.processWithdrawalRequests(fwr(1))).to.be.revertedWithCustomError(
        oracle,
        "InvalidMaxEBWeight",
      );
    });

    it("InvalidMaxEBWeight when weight exceeds uint16", async () => {
      await useSanityCheckerWeights(32n, 2n ** 16n);

      await expect(oracle.processWithdrawalRequests(fwr(1))).to.be.revertedWithCustomError(
        oracle,
        "InvalidMaxEBWeight",
      );
    });
  });

  context("pubkey retrieved from the module", () => {
    const BAD_MODULE_ID = 40;
    let badModule: StakingModule__MockBadKeys;

    beforeEach(async () => {
      badModule = (await ethers.deployContract("StakingModule__MockBadKeys")) as StakingModule__MockBadKeys;
      await stakingRouter.setStakingModuleWithdrawalCredentialsType(BAD_MODULE_ID, 0x01);
      await stakingRouter.setStakingModuleAddress(BAD_MODULE_ID, await badModule.getAddress());
    });

    it("reverts if the module returns empty data", async () => {
      await badModule.setReturned("0x");

      await expect(oracle.processWithdrawalRequests(fwr(BAD_MODULE_ID))).to.be.revertedWithCustomError(
        oracle,
        "InvalidRetrievedKeyLength",
      );
    });

    it("reverts if the module returns a too short key", async () => {
      await badModule.setReturned("0x" + "aa".repeat(47));

      await expect(oracle.processWithdrawalRequests(fwr(BAD_MODULE_ID))).to.be.revertedWithCustomError(
        oracle,
        "InvalidRetrievedKeyLength",
      );
    });

    it("reverts if the module returns more than one key", async () => {
      await badModule.setReturned("0x" + "aa".repeat(96));

      await expect(oracle.processWithdrawalRequests(fwr(BAD_MODULE_ID))).to.be.revertedWithCustomError(
        oracle,
        "InvalidRetrievedKeyLength",
      );
    });

    it("accepts a single key returned by the new module interface", async () => {
      // StakingModule__MockBadKeys returns plain `bytes`, as CSM and CMv2 do
      await badModule.setReturned(PUBKEY_AA);

      const [intents] = await oracle.processWithdrawalRequests.staticCall(fwr(BAD_MODULE_ID));
      expect(intents.length).to.equal(1);
      expect(intents[0].pubkey).to.equal(PUBKEY_AA);
    });
  });
});
