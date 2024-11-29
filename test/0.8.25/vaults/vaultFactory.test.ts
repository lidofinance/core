import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OssifiableProxy,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  VaultFactory,
  VaultStaffRoom,
} from "typechain-types";

import { certainAddress, createVaultProxy, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultFactory.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;
  let vaultOwner2: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let proxy: OssifiableProxy;
  let accountingImpl: Accounting;
  let accounting: Accounting;
  let implOld: StakingVault;
  let implNew: StakingVault__HarnessForTestUpgrade;
  let vaultStaffRoom: VaultStaffRoom;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;

  let locator: LidoLocator;

  let originalState: string;

  const treasury = certainAddress("treasury");

  before(async () => {
    [deployer, admin, holder, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // Accounting
    accountingImpl = await ethers.deployContract("Accounting", [locator, steth, treasury], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [accountingImpl, admin, new Uint8Array()], admin);
    accounting = await ethers.getContractAt("Accounting", proxy, deployer);
    await accounting.initialize(admin);

    implOld = await ethers.deployContract("StakingVault", [accounting, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [accounting, depositContract], {
      from: deployer,
    });
    vaultStaffRoom = await ethers.deployContract("VaultStaffRoom", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, vaultStaffRoom], { from: deployer });

    //add VAULT_MASTER_ROLE role to allow admin to connect the Vaults to the vault Hub
    await accounting.connect(admin).grantRole(await accounting.VAULT_MASTER_ROLE(), admin);
    //add VAULT_REGISTRY_ROLE role to allow admin to add factory and vault implementation to the hub
    await accounting.connect(admin).grantRole(await accounting.VAULT_REGISTRY_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, "0x")).to.revertedWithCustomError(implOld, "NonProxyCallsForbidden");
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

    it("reverts if `_vaultStaffRoom` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [admin, implOld, ZeroAddress], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_vaultStaffRoom");
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
      const { tx, vault, vaultStaffRoom: vsr } = await createVaultProxy(vaultFactory, vaultOwner1);

      await expect(tx)
        .to.emit(vaultFactory, "VaultCreated")
        .withArgs(await vsr.getAddress(), await vault.getAddress());

      await expect(tx)
        .to.emit(vaultFactory, "VaultStaffRoomCreated")
        .withArgs(await vaultOwner1.getAddress(), await vsr.getAddress());

      expect(await vsr.getAddress()).to.eq(await vault.owner());
      expect(await vault.getBeacon()).to.eq(await vaultFactory.getAddress());
    });

    it("works with non-empty `params`", async () => {});
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
      const { vault: vault1, vaultStaffRoom: delegator1 } = await createVaultProxy(vaultFactory, vaultOwner1);
      const { vault: vault2, vaultStaffRoom: delegator2 } = await createVaultProxy(vaultFactory, vaultOwner2);

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
      await accounting.connect(admin).addImpl(implOld);

      //connect vaults to VaultHub
      await accounting
        .connect(admin)
        .connectVault(
          await vault1.getAddress(),
          config1.shareLimit,
          config1.minReserveRatioBP,
          config1.thresholdReserveRatioBP,
          config1.treasuryFeeBP,
        );
      await accounting
        .connect(admin)
        .connectVault(
          await vault2.getAddress(),
          config2.shareLimit,
          config2.minReserveRatioBP,
          config2.thresholdReserveRatioBP,
          config2.treasuryFeeBP,
        );

      const vaultsAfter = await accounting.vaultsCount();
      expect(vaultsAfter).to.eq(2);

      const version1Before = await vault1.version();
      const version2Before = await vault2.version();

      const implBefore = await vaultFactory.implementation();
      expect(implBefore).to.eq(await implOld.getAddress());

      //upgrade beacon to new implementation
      await vaultFactory.connect(admin).upgradeTo(implNew);

      const implAfter = await vaultFactory.implementation();
      expect(implAfter).to.eq(await implNew.getAddress());

      //create new vault with new implementation
      const { vault: vault3 } = await createVaultProxy(vaultFactory, vaultOwner1);

      //we upgrade implementation and do not add it to whitelist
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

      const version1After = await vault1.version();
      const version2After = await vault2.version();
      const version3After = await vault3.version();

      expect(version1Before).not.to.eq(version1After);
      expect(version2Before).not.to.eq(version2After);
      expect(2).to.eq(version3After);
    });
  });
});
