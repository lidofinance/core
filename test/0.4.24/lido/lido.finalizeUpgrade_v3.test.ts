import { expect } from "chai";
import { MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import {
  Burner,
  Burner__MockForMigration,
  ICSModule__factory,
  Lido__HarnessForFinalizeUpgradeV3,
  LidoLocator,
  OssifiableProxy__factory,
} from "typechain-types";

import { certainAddress, ether, getStorageAtPosition, impersonate, proxify, TOTAL_BASIS_POINTS } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:finalizeUpgrade_v3", () => {
  let deployer: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV3;
  let lido: Lido__HarnessForFinalizeUpgradeV3;
  let locator: LidoLocator;

  const initialValue = 1n;
  const finalizeVersion = 3n;

  let withdrawalQueueAddress: string;
  let burner: Burner;
  let oldBurner: Burner__MockForMigration;

  const dummyLocatorAddress = certainAddress("dummy-locator");
  let simpleDvtAddress: string;
  let nodeOperatorsRegistryAddress: string;
  let csmAccountingAddress: string;

  const oldCoverSharesBurnRequested = 100n;
  const oldNonCoverSharesBurnRequested = 200n;
  const oldTotalCoverSharesBurnt = 300n;
  const oldTotalNonCoverSharesBurnt = 400n;
  const sharesOnOldBurner = 1000n;

  let originalState: string;

  before(async () => {
    [deployer] = await ethers.getSigners();
    impl = await ethers.deployContract("Lido__HarnessForFinalizeUpgradeV3");
    [lido] = await proxify({ impl, admin: deployer });

    burner = await ethers.deployContract("Burner", [dummyLocatorAddress, lido]);

    const proxyFactory = new OssifiableProxy__factory(deployer);
    const burnerProxy = await proxyFactory.deploy(burner, deployer, new Uint8Array());
    burner = burner.attach(burnerProxy) as Burner;

    const isMigrationAllowed = true;
    await burner.connect(deployer).initialize(deployer, isMigrationAllowed);
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForLidoUpgrade");

    nodeOperatorsRegistryAddress = (await stakingRouter.getStakingModule(1)).stakingModuleAddress;
    simpleDvtAddress = (await stakingRouter.getStakingModule(2)).stakingModuleAddress;
    csmAccountingAddress = await ICSModule__factory.connect(
      (await stakingRouter.getStakingModule(3)).stakingModuleAddress,
      deployer,
    ).accounting();

    locator = await deployLidoLocator({ burner, stakingRouter });

    withdrawalQueueAddress = await locator.withdrawalQueue();

    oldBurner = await ethers.deployContract("Burner__MockForMigration", []);
    await oldBurner
      .connect(deployer)
      .setSharesRequestedToBurn(oldCoverSharesBurnRequested, oldNonCoverSharesBurnRequested);
    await oldBurner.connect(deployer).setSharesBurnt(oldTotalCoverSharesBurnt, oldTotalNonCoverSharesBurnt);

    await lido.connect(await impersonate(nodeOperatorsRegistryAddress, ether("1"))).approve(oldBurner, MaxUint256);
    await lido.connect(await impersonate(simpleDvtAddress, ether("1"))).approve(oldBurner, MaxUint256);
    await lido.connect(await impersonate(csmAccountingAddress, ether("1"))).approve(oldBurner, MaxUint256);
    await lido.connect(await impersonate(withdrawalQueueAddress, ether("1"))).approve(oldBurner, MaxUint256);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  it("Reverts if not initialized", async () => {
    await expect(lido.finalizeUpgrade_v3(ZeroAddress, [], 0)).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("initialized", () => {
    before(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await lido.connect(deployer).harness_initialize_v2(locator, { value: initialValue });

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if contract version does not equal 2", async () => {
      const unexpectedVersion = 1n;
      await lido.harness_setContractVersion(unexpectedVersion);
      await expect(
        lido.finalizeUpgrade_v3(
          oldBurner,
          [nodeOperatorsRegistryAddress, simpleDvtAddress, csmAccountingAddress, withdrawalQueueAddress],
          0,
        ),
      ).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    });

    it("Reverts if old burner is the same as new burner", async () => {
      await expect(lido.finalizeUpgrade_v3(burner, [], 0)).to.be.revertedWith("OLD_BURNER_SAME_AS_NEW");
    });

    it("Reverts if old burner is zero address", async () => {
      await expect(lido.finalizeUpgrade_v3(ZeroAddress, [], 0)).to.be.revertedWith("OLD_BURNER_ADDRESS_ZERO");
    });

    it("Sets contract version to 3 and max external ratio to 10", async () => {
      await expect(
        lido.finalizeUpgrade_v3(
          oldBurner,
          [nodeOperatorsRegistryAddress, simpleDvtAddress, csmAccountingAddress, withdrawalQueueAddress],
          10,
        ),
      )
        .to.emit(lido, "ContractVersionSet")
        .withArgs(finalizeVersion)
        .and.emit(lido, "MaxExternalRatioBPSet")
        .withArgs(10);
      expect(await lido.getContractVersion()).to.equal(finalizeVersion);
      expect(await lido.getMaxExternalRatioBP()).to.equal(10);
    });

    it("Reverts if initial max external ratio is greater than total basis points", async () => {
      await expect(
        lido.finalizeUpgrade_v3(
          oldBurner,
          [nodeOperatorsRegistryAddress, simpleDvtAddress, csmAccountingAddress, withdrawalQueueAddress],
          TOTAL_BASIS_POINTS + 1n,
        ),
      ).to.be.revertedWith("INVALID_MAX_EXTERNAL_RATIO");
    });

    it("Migrates storage successfully", async () => {
      const totalShares = await getStorageAtPosition(lido, "lido.StETH.totalShares");
      const bufferedEther = await getStorageAtPosition(lido, "lido.Lido.bufferedEther");

      const beaconValidators = await getStorageAtPosition(lido, "lido.Lido.beaconValidators");
      const beaconBalance = await getStorageAtPosition(lido, "lido.Lido.beaconBalance");
      const depositedValidators = await getStorageAtPosition(lido, "lido.Lido.depositedValidators");

      await expect(
        lido.finalizeUpgrade_v3(
          oldBurner,
          [nodeOperatorsRegistryAddress, simpleDvtAddress, csmAccountingAddress, withdrawalQueueAddress],
          0,
        ),
      ).to.not.be.reverted;

      expect(await lido.getLidoLocator()).to.equal(locator);
      expect(await lido.getTotalShares()).to.equal(totalShares);
      expect(await lido.getBufferedEther()).to.equal(bufferedEther);

      expect((await lido.getBeaconStat()).beaconBalance).to.equal(beaconBalance);
      expect((await lido.getBeaconStat()).beaconValidators).to.equal(beaconValidators);
      expect((await lido.getBeaconStat()).depositedValidators).to.equal(depositedValidators);
    });

    it("Migrates burner successfully", async () => {
      await lido.harness_mintShares_v2(oldBurner, sharesOnOldBurner);
      expect(await lido.sharesOf(oldBurner)).to.equal(sharesOnOldBurner);

      await expect(
        lido.finalizeUpgrade_v3(
          oldBurner,
          [nodeOperatorsRegistryAddress, simpleDvtAddress, csmAccountingAddress, withdrawalQueueAddress],
          0,
        ),
      )
        .to.emit(lido, "TransferShares")
        .withArgs(oldBurner, burner, sharesOnOldBurner);

      expect(await lido.sharesOf(oldBurner)).to.equal(0n);
      expect(await lido.sharesOf(burner)).to.equal(sharesOnOldBurner);

      expect(await burner.getCoverSharesBurnt()).to.equal(oldTotalCoverSharesBurnt);
      expect(await burner.getNonCoverSharesBurnt()).to.equal(oldTotalNonCoverSharesBurnt);
      const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();
      expect(coverShares).to.equal(oldCoverSharesBurnRequested);
      expect(nonCoverShares).to.equal(oldNonCoverSharesBurnRequested);

      // Check old burner allowances are revoked
      expect(await lido.allowance(nodeOperatorsRegistryAddress, oldBurner)).to.equal(0n);
      expect(await lido.allowance(simpleDvtAddress, oldBurner)).to.equal(0n);
      expect(await lido.allowance(csmAccountingAddress, oldBurner)).to.equal(0n);
      expect(await lido.allowance(withdrawalQueueAddress, oldBurner)).to.equal(0n);

      // Check new burner allowances are set
      expect(await lido.allowance(nodeOperatorsRegistryAddress, burner)).to.equal(MaxUint256);
      expect(await lido.allowance(simpleDvtAddress, burner)).to.equal(MaxUint256);
      expect(await lido.allowance(csmAccountingAddress, burner)).to.equal(MaxUint256);
      expect(await lido.allowance(withdrawalQueueAddress, burner)).to.equal(MaxUint256);
    });
  });
});
