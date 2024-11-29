import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  VaultFactory,
  VaultHub,
  Delegation,
} from "typechain-types";

import { certainAddress, createVaultProxy, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultFactory.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let lidoAgent: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;
  let vaultOwner2: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultHub: VaultHub;
  let implOld: StakingVault;
  let implNew: StakingVault__HarnessForTestUpgrade;
  let delegation: Delegation;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;

  let locator: LidoLocator;

  let originalState: string;

  const treasury = certainAddress("treasury");

  before(async () => {
    [deployer, admin, holder, stranger, vaultOwner1, vaultOwner2, lidoAgent] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // VaultHub
    vaultHub = await ethers.deployContract("Accounting", [admin, locator, steth, treasury], { from: deployer });
    implOld = await ethers.deployContract("StakingVault", [vaultHub, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [vaultHub, depositContract], {
      from: deployer,
    });
    delegation = await ethers.deployContract("Delegation", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, delegation], { from: deployer });

    //add role to factory
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);

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
      const { tx, vault, delegation } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await expect(tx)
        .to.emit(vaultFactory, "VaultCreated")
        .withArgs(await delegation.getAddress(), await vault.getAddress());

      await expect(tx)
        .to.emit(vaultFactory, "DelegationCreated")
        .withArgs(await vaultOwner1.getAddress(), await delegation.getAddress());

      expect(await delegation.getAddress()).to.eq(await vault.owner());
      expect(await vault.getBeacon()).to.eq(await vaultFactory.getAddress());
    });

    it("works with non-empty `params`", async () => { });
  });

  context("connect", () => {
    it("connect ", async () => {
      const vaultsBefore = await vaultHub.vaultsCount();
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
      const { vault: vault1, delegation: delegator1 } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);
      const { vault: vault2, delegation: delegator2 } = await createVaultProxy(vaultFactory, vaultOwner2, lidoAgent);

      //owner of vault is delegator
      expect(await delegator1.getAddress()).to.eq(await vault1.owner());
      expect(await delegator2.getAddress()).to.eq(await vault2.owner());

      //try to connect vault without, factory not allowed
      await expect(
        vaultHub
          .connect(admin)
          .connectVault(
            await vault1.getAddress(),
            config1.shareLimit,
            config1.minReserveRatioBP,
            config1.thresholdReserveRatioBP,
            config1.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(vaultHub, "FactoryNotAllowed");

      //add factory to whitelist
      await vaultHub.connect(admin).addFactory(vaultFactory);

      //try to connect vault without, impl not allowed
      await expect(
        vaultHub
          .connect(admin)
          .connectVault(
            await vault1.getAddress(),
            config1.shareLimit,
            config1.minReserveRatioBP,
            config1.thresholdReserveRatioBP,
            config1.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(vaultHub, "ImplNotAllowed");

      //add impl to whitelist
      await vaultHub.connect(admin).addImpl(implOld);

      //connect vaults to VaultHub
      await vaultHub
        .connect(admin)
        .connectVault(
          await vault1.getAddress(),
          config1.shareLimit,
          config1.minReserveRatioBP,
          config1.thresholdReserveRatioBP,
          config1.treasuryFeeBP,
        );
      await vaultHub
        .connect(admin)
        .connectVault(
          await vault2.getAddress(),
          config2.shareLimit,
          config2.minReserveRatioBP,
          config2.thresholdReserveRatioBP,
          config2.treasuryFeeBP,
        );

      const vaultsAfter = await vaultHub.vaultsCount();
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
      const { vault: vault3 } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      //we upgrade implementation and do not add it to whitelist
      await expect(
        vaultHub
          .connect(admin)
          .connectVault(
            await vault1.getAddress(),
            config1.shareLimit,
            config1.minReserveRatioBP,
            config1.thresholdReserveRatioBP,
            config1.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(vaultHub, "ImplNotAllowed");

      const version1After = await vault1.version();
      const version2After = await vault2.version();
      const version3After = await vault3.version();

      expect(version1Before).not.to.eq(version1After);
      expect(version2Before).not.to.eq(version2After);
      expect(2).to.eq(version3After);
    });
  });
});
