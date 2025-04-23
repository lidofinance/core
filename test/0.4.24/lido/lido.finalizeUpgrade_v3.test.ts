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
} from "typechain-types";

import { certainAddress, ether, impersonate, proxify } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Lido.sol:finalizeUpgrade_v3", () => {
  let deployer: HardhatEthersSigner;

  let impl: Lido__HarnessForFinalizeUpgradeV3;
  let lido: Lido__HarnessForFinalizeUpgradeV3;
  let locator: LidoLocator;

  const initialValue = 1n;
  const initialVersion = 2n;
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

    burner = await ethers.deployContract("Burner", [deployer.address, dummyLocatorAddress, lido.target, true]);
    const stakingRouter = await ethers.deployContract("StakingRouter__MockForLidoUpgrade");

    nodeOperatorsRegistryAddress = (await stakingRouter.getStakingModule(1)).stakingModuleAddress;
    simpleDvtAddress = (await stakingRouter.getStakingModule(2)).stakingModuleAddress;
    csmAccountingAddress = await ICSModule__factory.connect(
      (await stakingRouter.getStakingModule(3)).stakingModuleAddress,
      deployer,
    ).accounting();

    locator = await deployLidoLocator({ burner: burner.target, stakingRouter: stakingRouter.target });

    withdrawalQueueAddress = await locator.withdrawalQueue();

    oldBurner = await ethers.deployContract("Burner__MockForMigration", []);
    await oldBurner
      .connect(deployer)
      .setSharesRequestedToBurn(oldCoverSharesBurnRequested, oldNonCoverSharesBurnRequested);
    await oldBurner.connect(deployer).setSharesBurnt(oldTotalCoverSharesBurnt, oldTotalNonCoverSharesBurnt);

    await lido
      .connect(await impersonate(nodeOperatorsRegistryAddress, ether("1")))
      .approve(oldBurner.target, MaxUint256);
    await lido.connect(await impersonate(simpleDvtAddress, ether("1"))).approve(oldBurner.target, MaxUint256);
    await lido.connect(await impersonate(csmAccountingAddress, ether("1"))).approve(oldBurner.target, MaxUint256);
    await lido.connect(await impersonate(withdrawalQueueAddress, ether("1"))).approve(oldBurner.target, MaxUint256);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  it("Reverts if not initialized", async () => {
    await expect(lido.harness_setContractVersion(initialVersion))
      .and.to.emit(lido, "ContractVersionSet")
      .withArgs(initialVersion);

    await expect(
      lido.finalizeUpgrade_v3(ZeroAddress, [
        nodeOperatorsRegistryAddress,
        simpleDvtAddress,
        csmAccountingAddress,
        withdrawalQueueAddress,
      ]),
    ).to.be.revertedWith("NOT_INITIALIZED");
  });

  context("initialized", () => {
    before(async () => {
      const latestBlock = BigInt(await time.latestBlock());

      await lido.connect(deployer).harness_initialize_v2(locator.target, { value: initialValue });

      expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
      expect(await lido.getInitializationBlock()).to.equal(latestBlock + 1n);
    });

    it("Reverts if contract version does not equal 2", async () => {
      const unexpectedVersion = 1n;
      await lido.harness_setContractVersion(unexpectedVersion);
      await expect(
        lido.finalizeUpgrade_v3(ZeroAddress, [
          nodeOperatorsRegistryAddress,
          simpleDvtAddress,
          csmAccountingAddress,
          withdrawalQueueAddress,
        ]),
      ).to.be.reverted;
    });

    it("Reverts if old burner is the same as new burner", async () => {
      await expect(
        lido.finalizeUpgrade_v3(burner.target, [
          nodeOperatorsRegistryAddress,
          simpleDvtAddress,
          csmAccountingAddress,
          withdrawalQueueAddress,
        ]),
      ).to.be.revertedWith("OLD_BURNER_SAME_AS_NEW");
    });

    it("Sets contract version to 3", async () => {
      await expect(
        lido.finalizeUpgrade_v3(oldBurner.target, [
          nodeOperatorsRegistryAddress,
          simpleDvtAddress,
          csmAccountingAddress,
          withdrawalQueueAddress,
        ]),
      )
        .and.to.emit(lido, "ContractVersionSet")
        .withArgs(finalizeVersion);

      expect(await lido.getContractVersion()).to.equal(finalizeVersion);
    });

    it("Migrates burner successfully", async () => {
      await lido.harness_mintShares(oldBurner.target, sharesOnOldBurner);
      expect(await lido.sharesOf(oldBurner.target)).to.equal(sharesOnOldBurner);

      await expect(
        lido.finalizeUpgrade_v3(oldBurner.target, [
          nodeOperatorsRegistryAddress,
          simpleDvtAddress,
          csmAccountingAddress,
          withdrawalQueueAddress,
        ]),
      )
        .and.to.emit(lido, "TransferShares")
        .withArgs(oldBurner.target, burner.target, sharesOnOldBurner);

      expect(await lido.sharesOf(oldBurner.target)).to.equal(0n);
      expect(await lido.sharesOf(burner.target)).to.equal(sharesOnOldBurner);

      expect(await burner.getCoverSharesBurnt()).to.equal(oldTotalCoverSharesBurnt);
      expect(await burner.getNonCoverSharesBurnt()).to.equal(oldTotalNonCoverSharesBurnt);
      const [coverShares, nonCoverShares] = await burner.getSharesRequestedToBurn();
      expect(coverShares).to.equal(oldCoverSharesBurnRequested);
      expect(nonCoverShares).to.equal(oldNonCoverSharesBurnRequested);

      // Check old burner allowances are revoked
      expect(await lido.allowance(nodeOperatorsRegistryAddress, oldBurner.target)).to.equal(0n);
      expect(await lido.allowance(simpleDvtAddress, oldBurner.target)).to.equal(0n);
      expect(await lido.allowance(csmAccountingAddress, oldBurner.target)).to.equal(0n);
      expect(await lido.allowance(withdrawalQueueAddress, oldBurner.target)).to.equal(0n);

      // Check new burner allowances are set
      expect(await lido.allowance(nodeOperatorsRegistryAddress, burner.target)).to.equal(MaxUint256);
      expect(await lido.allowance(simpleDvtAddress, burner.target)).to.equal(MaxUint256);
      expect(await lido.allowance(csmAccountingAddress, burner.target)).to.equal(MaxUint256);
      expect(await lido.allowance(withdrawalQueueAddress, burner.target)).to.equal(MaxUint256);
    });
  });
});
