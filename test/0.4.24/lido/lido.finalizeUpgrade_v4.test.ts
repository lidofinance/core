import { expect } from "chai";
import { MaxUint256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  AccountingOracle__MockForStakingRouter,
  Lido__HarnessForFinalizeUpgradeV4,
  LidoLocator,
} from "typechain-types";

import { ether, getStorageAtPositionAsUint128Pair, proxify } from "lib";

import { deployLidoLocator } from "test/deploy/locator";
import { Snapshot } from "test/suite";

describe("Lido.sol:finalizeUpgrade_v4", () => {
  let deployer: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV4;
  let lido: Lido__HarnessForFinalizeUpgradeV4;
  let accountingOracle: AccountingOracle__MockForStakingRouter;
  let locator: LidoLocator;

  const initialValue = 1n;
  const finalizeVersion = 4n;

  let originalState: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    impl = await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV4", {
      signer: deployer,
    });
    [lido] = await proxify({ impl, admin: deployer });
    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);
    locator = await deployLidoLocator({ lido, accountingOracle }, deployer);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  it("Reverts if not initialized", async () => {
    await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("initialized", () => {
    before(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await lido.connect(deployer).harness_initialize_v3(locator, { value: initialValue });

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if contract version does not equal 3", async () => {
      const unexpectedVersion = 1n;
      await lido.harness_setContractVersion(unexpectedVersion);
      await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    });

    it("Sets contract version to 4", async () => {
      await expect(lido.finalizeUpgrade_v4()).to.emit(lido, "ContractVersionSet").withArgs(finalizeVersion);
      expect(await lido.getContractVersion()).to.equal(finalizeVersion);
    });

    it("Reverts upgrade if occurred before report", async () => {
      await accountingOracle.mock_setProcessingState(1, false, false);
      await expect(lido.finalizeUpgrade_v4()).to.be.revertedWith("NO_REPORT");
    });

    it("Migrates storage successfully after report and before next frame", async () => {
      // simulate report

      const { low: bufferedEther, high: depositedValidators } = await getStorageAtPositionAsUint128Pair(
        lido,
        "lido.Lido.bufferedEtherAndDepositedValidators",
      );
      const { low: clBalance, high: clValidators } = await getStorageAtPositionAsUint128Pair(
        lido,
        "lido.Lido.clBalanceAndClValidators",
      );

      const depositedBalance = (depositedValidators - clValidators) * ether("32");

      await expect(lido.finalizeUpgrade_v4()).to.not.be.reverted;

      expect(await lido.getBufferedEther()).to.equal(bufferedEther);
      expect((await lido.getBeaconStat()).beaconBalance).to.equal(clBalance);
      expect((await lido.getBeaconStat()).beaconValidators).to.equal(depositedValidators);
      expect((await lido.getBeaconStat()).depositedValidators).to.equal(depositedValidators);
      expect((await lido.getBalanceStats()).clValidatorsBalanceAtLastReport).to.equal(clBalance);
      expect((await lido.getBalanceStats()).clPendingBalanceAtLastReport).to.equal(0);
      expect((await lido.getBalanceStats()).depositedSinceLastReport).to.equal(depositedBalance);
    });
  });
});
