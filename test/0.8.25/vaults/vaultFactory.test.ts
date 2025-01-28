import { expect } from "chai";
import { keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  BeaconProxy,
  Delegation,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OssifiableProxy,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  UpgradeableBeacon,
  VaultFactory,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";
import { DelegationConfigStruct } from "typechain-types/contracts/0.8.25/vaults/VaultFactory";

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
  let beacon: UpgradeableBeacon;
  let accountingImpl: Accounting;
  let accounting: Accounting;
  let implOld: StakingVault;
  let implNew: StakingVault__HarnessForTestUpgrade;
  let delegation: Delegation;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;

  let locator: LidoLocator;

  let vaultBeaconProxy: BeaconProxy;
  let vaultBeaconProxyCode: string;

  let originalState: string;

  let delegationParams: DelegationConfigStruct;

  before(async () => {
    [deployer, admin, holder, operator, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // Accounting
    accountingImpl = await ethers.deployContract("Accounting", [locator, steth], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [accountingImpl, admin, new Uint8Array()], admin);
    accounting = await ethers.getContractAt("Accounting", proxy, deployer);
    await accounting.initialize(admin);

    //vault implementation
    implOld = await ethers.deployContract("StakingVault", [accounting, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [accounting, depositContract], {
      from: deployer,
    });

    //beacon
    beacon = await ethers.deployContract("UpgradeableBeacon", [implOld, admin]);

    vaultBeaconProxy = await ethers.deployContract("BeaconProxy", [beacon, "0x"]);
    vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());

    delegation = await ethers.deployContract("Delegation", [steth, weth, wsteth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [beacon, delegation], { from: deployer });

    //add VAULT_MASTER_ROLE role to allow admin to connect the Vaults to the vault Hub
    await accounting.connect(admin).grantRole(await accounting.VAULT_MASTER_ROLE(), admin);
    //add VAULT_REGISTRY_ROLE role to allow admin to add factory and vault implementation to the hub
    await accounting.connect(admin).grantRole(await accounting.VAULT_REGISTRY_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, operator, "0x")).to.revertedWithCustomError(
      implOld,
      "InvalidInitialization",
    );

    delegationParams = {
      defaultAdmin: await admin.getAddress(),
      funder: await vaultOwner1.getAddress(),
      withdrawer: await vaultOwner1.getAddress(),
      minter: await vaultOwner1.getAddress(),
      burner: await vaultOwner1.getAddress(),
      curator: await vaultOwner1.getAddress(),
      rebalancer: await vaultOwner1.getAddress(),
      depositPauser: await vaultOwner1.getAddress(),
      depositResumer: await vaultOwner1.getAddress(),
      exitRequester: await vaultOwner1.getAddress(),
      disconnecter: await vaultOwner1.getAddress(),
      nodeOperatorManager: await operator.getAddress(),
      nodeOperatorFeeClaimer: await operator.getAddress(),
      curatorFeeBP: 100n,
      nodeOperatorFeeBP: 200n,
    };
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts if `_owner` is zero address", async () => {
      await expect(ethers.deployContract("UpgradeableBeacon", [ZeroAddress, admin], { from: deployer }))
        .to.be.revertedWithCustomError(beacon, "BeaconInvalidImplementation")
        .withArgs(ZeroAddress);
    });
    it("reverts if `_owner` is zero address", async () => {
      await expect(ethers.deployContract("UpgradeableBeacon", [implOld, ZeroAddress], { from: deployer }))
        .to.be.revertedWithCustomError(beacon, "OwnableInvalidOwner")
        .withArgs(ZeroAddress);
    });

    it("reverts if `_implementation` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [ZeroAddress, steth], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_beacon");
    });

    it("reverts if `_delegation` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [beacon, ZeroAddress], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_delegation");
    });

    it("works and emit `OwnershipTransferred`, `Upgraded` events", async () => {
      const tx = beacon.deploymentTransaction();

      await expect(tx)
        .to.emit(beacon, "OwnershipTransferred")
        .withArgs(ZeroAddress, await admin.getAddress());
      await expect(tx)
        .to.emit(beacon, "Upgraded")
        .withArgs(await implOld.getAddress());
    });
  });

  context("createVaultWithDelegation", () => {
    it("reverts if `curator` is zero address", async () => {
      const params = { ...delegationParams, curator: ZeroAddress };
      await expect(createVaultProxy(vaultOwner1, vaultFactory, params))
        .to.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("curator");
    });

    it("works with empty `params`", async () => {
      const {
        tx,
        vault,
        delegation: delegation_,
      } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);

      await expect(tx)
        .to.emit(vaultFactory, "VaultCreated")
        .withArgs(await delegation_.getAddress(), await vault.getAddress());

      await expect(tx)
        .to.emit(vaultFactory, "DelegationCreated")
        .withArgs(await admin.getAddress(), await delegation_.getAddress());

      expect(await delegation_.getAddress()).to.eq(await vault.owner());
    });

    it("check `version()`", async () => {
      const { vault } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);
      expect(await vault.version()).to.eq(1);
    });
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

      //create vaults
      const { vault: vault1, delegation: delegator1 } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        delegationParams,
      );
      const { vault: vault2, delegation: delegator2 } = await createVaultProxy(
        vaultOwner2,
        vaultFactory,
        delegationParams,
      );

      //owner of vault is delegator
      expect(await delegator1.getAddress()).to.eq(await vault1.owner());
      expect(await delegator2.getAddress()).to.eq(await vault2.owner());

      //attempting to add a vault without adding a proxy bytecode to the allowed list
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
      ).to.revertedWithCustomError(accounting, "VaultProxyNotAllowed");

      const vaultProxyCodeHash = keccak256(vaultBeaconProxyCode);

      //add proxy code hash to whitelist
      await accounting.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);

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

      const implBefore = await beacon.implementation();
      expect(implBefore).to.eq(await implOld.getAddress());

      //upgrade beacon to new implementation
      await beacon.connect(admin).upgradeTo(implNew);

      const implAfter = await beacon.implementation();
      expect(implAfter).to.eq(await implNew.getAddress());

      //create new vault with new implementation
      const { vault: vault3 } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);

      //we upgrade implementation - we do not check implementation, just proxy bytecode
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
      ).to.not.revertedWithCustomError(accounting, "VaultProxyNotAllowed");

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);
      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);
      const vault3WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault3, deployer);

      //finalize first vault
      await vault1WithNewImpl.finalizeUpgrade_v2();

      //try to initialize the second vault
      await expect(vault2WithNewImpl.initialize(admin, operator, "0x")).to.revertedWithCustomError(
        vault2WithNewImpl,
        "VaultAlreadyInitialized",
      );

      const version1After = await vault1WithNewImpl.version();
      const version2After = await vault2WithNewImpl.version();
      const version3After = await vault3WithNewImpl.version();

      const version1AfterV2 = await vault1WithNewImpl.getInitializedVersion();
      const version2AfterV2 = await vault2WithNewImpl.getInitializedVersion();
      const version3AfterV2 = await vault3WithNewImpl.getInitializedVersion();

      expect(version1Before).to.eq(1);
      expect(version1After).to.eq(2);
      expect(version1AfterV2).to.eq(2);

      expect(version2Before).to.eq(1);
      expect(version2After).to.eq(2);
      expect(version2AfterV2).to.eq(1);

      expect(version3After).to.eq(2);
      expect(version3AfterV2).to.eq(2);
    });
  });

  context("After upgrade", () => {
    it("exists vaults - init not works, finalize works ", async () => {
      const { vault: vault1 } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);

      await beacon.connect(admin).upgradeTo(implNew);

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);

      await expect(vault1.initialize(ZeroAddress, ZeroAddress, "0x")).to.revertedWithCustomError(
        vault1WithNewImpl,
        "VaultAlreadyInitialized",
      );
      await expect(vault1WithNewImpl.finalizeUpgrade_v2()).to.emit(vault1WithNewImpl, "InitializedV2");
    });

    it("new vaults - init works, finalize not works ", async () => {
      await beacon.connect(admin).upgradeTo(implNew);

      const { vault: vault2 } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);

      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);

      await expect(vault2.initialize(ZeroAddress, ZeroAddress, "0x")).to.revertedWithCustomError(
        vault2WithNewImpl,
        "InvalidInitialization",
      );
      await expect(vault2WithNewImpl.finalizeUpgrade_v2()).to.revertedWithCustomError(
        vault2WithNewImpl,
        "InvalidInitialization",
      );
    });
  });
});
