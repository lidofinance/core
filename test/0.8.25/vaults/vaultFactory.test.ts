import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  Delegation,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OssifiableProxy,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  VaultFactory,
} from "typechain-types";

import { createVaultProxy, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultFactory.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;
  let vaultOwner2: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let proxy: OssifiableProxy;
  let accountingImpl: Accounting;
  let accounting: Accounting;
  let implOld: StakingVault;
  let implNew: StakingVault__HarnessForTestUpgrade;
  let delegation: Delegation;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;

  let locator: LidoLocator;

  let originalState: string;

  before(async () => {
    [deployer, admin, holder, operator, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // Accounting
    accountingImpl = await ethers.deployContract("Accounting", [locator, steth], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [accountingImpl, admin, new Uint8Array()], admin);
    accounting = await ethers.getContractAt("Accounting", proxy, deployer);
    await accounting.initialize(admin);

    implOld = await ethers.deployContract("StakingVault", [accounting, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [accounting, depositContract], {
      from: deployer,
    });
    delegation = await ethers.deployContract("Delegation", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, delegation], { from: deployer });

    //add VAULT_MASTER_ROLE role to allow admin to connect the Vaults to the vault Hub
    await accounting.connect(admin).grantRole(await accounting.VAULT_MASTER_ROLE(), admin);
    //add VAULT_REGISTRY_ROLE role to allow admin to add factory and vault implementation to the hub
    await accounting.connect(admin).grantRole(await accounting.VAULT_REGISTRY_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, operator, "0x")).to.revertedWithCustomError(implOld, "SenderNotBeacon");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if `_owner` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [ZeroAddress, implOld, steth], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "OwnableInvalidOwner")
        .withArgs(ZeroAddress);
    });

    it("reverts if `_implementation` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [admin, ZeroAddress, steth], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "BeaconInvalidImplementation")
        .withArgs(ZeroAddress);
    });

    it("reverts if `_delegation` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [admin, implOld, ZeroAddress], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_delegation");
    });

    it("works and emit `OwnershipTransferred`, `Upgraded` events", async () => {
      const beacon = await ethers.deployContract(
        "VaultFactory",
        [await admin.getAddress(), await implOld.getAddress(), await steth.getAddress()],
        { from: deployer },
      );

      const tx = beacon.deploymentTransaction();

      await expect(tx)
        .to.emit(beacon, "OwnershipTransferred")
        .withArgs(ZeroAddress, await admin.getAddress());
      await expect(tx)
        .to.emit(beacon, "Upgraded")
        .withArgs(await implOld.getAddress());
    });
  });

  context("createVault", () => {
    it("works with empty `params`", async () => {
      const { tx, vault, delegation: delegation_ } = await createVaultProxy(vaultFactory, vaultOwner1, operator);

      await expect(tx)
        .to.emit(vaultFactory, "VaultCreated")
        .withArgs(await delegation_.getAddress(), await vault.getAddress());

      await expect(tx)
        .to.emit(vaultFactory, "DelegationCreated")
        .withArgs(await vaultOwner1.getAddress(), await delegation_.getAddress());

      expect(await delegation_.getAddress()).to.eq(await vault.owner());
      expect(await vault.getBeacon()).to.eq(await vaultFactory.getAddress());
    });

    it("check `version()`", async () => {
      const { vault } = await createVaultProxy(vaultFactory, vaultOwner1, operator);
      expect(await vault.version()).to.eq(1);
    });

    it.skip("works with non-empty `params`", async () => {});
  });

  context("connect", () => {
    it("connect ", async () => {
      const vaultsBefore = await accounting.vaultsCount();
      expect(vaultsBefore).to.eq(0);

      const config1 = {
        shareLimit: 10n,
        minReserveRatioBP: 500n,
        thresholdReserveRatioBP: 20n,
        treasuryFeeBP: 500n,
      };
      const config2 = {
        shareLimit: 20n,
        minReserveRatioBP: 200n,
        thresholdReserveRatioBP: 20n,
        treasuryFeeBP: 600n,
      };

      //create vault
      const { vault: vault1, delegation: delegator1 } = await createVaultProxy(vaultFactory, vaultOwner1, operator);
      const { vault: vault2, delegation: delegator2 } = await createVaultProxy(vaultFactory, vaultOwner2, operator);

      //owner of vault is delegator
      expect(await delegator1.getAddress()).to.eq(await vault1.owner());
      expect(await delegator2.getAddress()).to.eq(await vault2.owner());

      //try to connect vault without, factory not allowed
      await expect(
        accounting
          .connect(admin)
          .connectVault(
            await vault1.getAddress(),
            config1.shareLimit,
            config1.minReserveRatioBP,
            config1.thresholdReserveRatioBP,
            config1.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(accounting, "FactoryNotAllowed");

      //add factory to whitelist
      await accounting.connect(admin).addFactory(vaultFactory);

      //try to connect vault without, impl not allowed
      await expect(
        accounting
          .connect(admin)
          .connectVault(
            await vault1.getAddress(),
            config1.shareLimit,
            config1.minReserveRatioBP,
            config1.thresholdReserveRatioBP,
            config1.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(accounting, "ImplNotAllowed");

      //add impl to whitelist
      await accounting.connect(admin).addVaultImpl(implOld);

      //connect vault 1 to VaultHub
      await accounting
        .connect(admin)
        .connectVault(
          await vault1.getAddress(),
          config1.shareLimit,
          config1.minReserveRatioBP,
          config1.thresholdReserveRatioBP,
          config1.treasuryFeeBP,
        );

      const vaultsAfter = await accounting.vaultsCount();
      expect(vaultsAfter).to.eq(1);

      const version1Before = await vault1.version();
      const version2Before = await vault2.version();

      const implBefore = await vaultFactory.implementation();
      expect(implBefore).to.eq(await implOld.getAddress());

      //upgrade beacon to new implementation
      await vaultFactory.connect(admin).upgradeTo(implNew);

      const implAfter = await vaultFactory.implementation();
      expect(implAfter).to.eq(await implNew.getAddress());

      //create new vault with new implementation
      const { vault: vault3 } = await createVaultProxy(vaultFactory, vaultOwner1, operator);

      //we upgrade implementation and do not add it to whitelist
      await expect(
        accounting
          .connect(admin)
          .connectVault(
            await vault2.getAddress(),
            config2.shareLimit,
            config2.minReserveRatioBP,
            config2.thresholdReserveRatioBP,
            config2.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(accounting, "ImplNotAllowed");

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);
      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);
      const vault3WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault3, deployer);

      //finalize first vault
      await vault1WithNewImpl.finalizeUpgrade_v2();

      const version1After = await vault1WithNewImpl.version();
      const version2After = await vault2WithNewImpl.version();
      const version3After = await vault3WithNewImpl.version();

      const version1AfterV2 = await vault1WithNewImpl.getInitializedVersion();
      const version2AfterV2 = await vault2WithNewImpl.getInitializedVersion();
      const version3AfterV2 = await vault3WithNewImpl.getInitializedVersion();

      expect(version1Before).to.eq(1);
      expect(version1AfterV2).to.eq(2);

      expect(version2Before).to.eq(1);
      expect(version2AfterV2).to.eq(1);

      expect(version3After).to.eq(2);

      const v1 = { version: version1After, getInitializedVersion: version1AfterV2 };
      const v2 = { version: version2After, getInitializedVersion: version2AfterV2 };
      const v3 = { version: version3After, getInitializedVersion: version3AfterV2 };

      console.table([v1, v2, v3]);

      // await vault1.initialize(stranger, "0x")
      // await vault2.initialize(stranger, "0x")
      // await vault3.initialize(stranger, "0x")
    });
  });
});
