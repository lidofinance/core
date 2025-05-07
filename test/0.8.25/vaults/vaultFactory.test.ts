import { expect } from "chai";
import { keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconProxy,
  Dashboard,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  PredepositGuarantee_HarnessForFactory,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub,
  WstETH__HarnessForVault,
} from "typechain-types";

import { days, ether, GENESIS_FORK_VERSION } from "lib";
import { createVaultProxy } from "lib/protocol/helpers";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

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
  let vaultHubImpl: VaultHub;
  let vaultHub: VaultHub;
  let implOld: StakingVault;
  let implNew: StakingVault__HarnessForTestUpgrade;
  let dashboard: Dashboard;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;
  let wsteth: WstETH__HarnessForVault;

  let locator: LidoLocator;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;

  let vaultBeaconProxy: BeaconProxy;
  let vaultBeaconProxyCode: string;
  let vaultProxyCodeHash: string;
  let originalState: string;

  before(async () => {
    [deployer, admin, holder, operator, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    //predeposit guarantee
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
      GENESIS_FORK_VERSION,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    locator = await deployLidoLocator({
      lido: steth,
      wstETH: wsteth,
      predepositGuarantee: predepositGuarantee,
    });

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, deployer, new Uint8Array()], deployer);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, deployer);

    const defaultTierParams = {
      shareLimit: ether("1"),
      reserveRatioBP: 2000n,
      forcedRebalanceThresholdBP: 1800n,
      infraFeeBP: 500n,
      liquidityFeeBP: 400n,
      reservationFeeBP: 100n,
    };
    await operatorGrid.initialize(admin, defaultTierParams);
    await operatorGrid.connect(admin).grantRole(await operatorGrid.REGISTRY_ROLE(), admin);

    await updateLidoLocatorImplementation(await locator.getAddress(), { operatorGrid });

    // Accounting
    vaultHubImpl = await ethers.deployContract("VaultHub", [locator, steth, VAULTS_RELATIVE_SHARE_LIMIT_BP]);
    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, admin, new Uint8Array()], admin);
    vaultHub = await ethers.getContractAt("VaultHub", proxy, deployer);
    await vaultHub.initialize(admin);

    //vault implementation
    implOld = await ethers.deployContract("StakingVault", [vaultHub, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [vaultHub, depositContract], {
      from: deployer,
    });

    //beacon
    beacon = await ethers.deployContract("UpgradeableBeacon", [implOld, admin]);

    vaultBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
    vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());
    vaultProxyCodeHash = keccak256(vaultBeaconProxyCode);

    dashboard = await ethers.deployContract("Dashboard", [steth, wsteth, vaultHub], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [locator, beacon, dashboard], {
      from: deployer,
    });

    //add VAULT_MASTER_ROLE role to allow admin to connect the Vaults to the vault Hub
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);
    //add VAULT_REGISTRY_ROLE role to allow admin to add factory and vault implementation to the hub
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, operator, predepositGuarantee, "0x")).to.revertedWithCustomError(
      implOld,
      "InvalidInitialization",
    );
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

    it("reverts if `_lidoLocator` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [ZeroAddress, beacon, dashboard], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_lidoLocator");
    });

    it("reverts if `_implementation` is zero address", async () => {
      await expect(
        ethers.deployContract("VaultFactory", [locator, ZeroAddress, dashboard], {
          from: deployer,
        }),
      )
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_beacon");
    });

    it("reverts if `_dashboard` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [locator, beacon, ZeroAddress], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_dashboardImpl");
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

  context("createVaultWithDashboard", () => {
    it("works with empty `params`", async () => {
      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);
      const {
        tx,
        vault,
        dashboard: dashboard_,
      } = await createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator, operator, 200n, days(7n), [], "0x");

      await expect(tx)
        .to.emit(vaultFactory, "VaultCreated")
        .withArgs(await vault.getAddress(), await dashboard_.getAddress());

      await expect(tx)
        .to.emit(vaultFactory, "DashboardCreated")
        .withArgs(await dashboard_.getAddress(), vaultOwner1);

      expect(await dashboard_.getAddress()).to.eq(await vault.owner());
    });

    it("check `version()`", async () => {
      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);
      const { vault } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [],
        "0x",
      );
      expect(await vault.version()).to.eq(1);
    });
  });

  context("connect", () => {
    it("connect ", async () => {
      const vaultsBefore = await vaultHub.vaultsCount();
      expect(vaultsBefore).to.eq(0);

      //attempting to create and connect a vault without adding a proxy bytecode to the allowed list
      await expect(
        createVaultProxy(vaultOwner1, vaultFactory, vaultOwner1, operator, operator, 200n, days(7n), [], "0x"),
      ).to.revertedWithCustomError(vaultHub, "VaultProxyNotAllowed");

      //add proxy code hash to whitelist
      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);

      //create vaults
      const { vault: vault1, dashboard: dashboard1 } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [],
        "0x",
      );
      const { vault: vault2, dashboard: dashboard2 } = await createVaultProxy(
        vaultOwner2,
        vaultFactory,
        vaultOwner2,
        operator,
        operator,
        200n,
        days(7n),
        [],
        "0x",
      );

      //owner of vault is delegator
      expect(await dashboard1.getAddress()).to.eq(await vault1.owner());
      expect(await dashboard2.getAddress()).to.eq(await vault2.owner());

      const vaultsAfter = await vaultHub.vaultsCount();
      expect(vaultsAfter).to.eq(2);

      const version1Before = await vault1.version();
      const version2Before = await vault2.version();

      const implBefore = await beacon.implementation();
      expect(implBefore).to.eq(await implOld.getAddress());

      //upgrade beacon to new implementation
      await beacon.connect(admin).upgradeTo(implNew);

      const implAfter = await beacon.implementation();
      expect(implAfter).to.eq(await implNew.getAddress());

      //create new vault with new implementation
      const { vault: vault3 } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [],
        "0x",
      );

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);
      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);
      const vault3WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault3, deployer);

      //finalize first vault
      await vault1WithNewImpl.finalizeUpgrade_v2();

      //try to initialize the second vault
      await expect(vault2WithNewImpl.initialize(admin, operator, predepositGuarantee, "0x")).to.revertedWithCustomError(
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
      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);
      const { vault: vault1 } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [],
        "0x",
      );

      await beacon.connect(admin).upgradeTo(implNew);

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);

      await expect(vault1.initialize(ZeroAddress, ZeroAddress, ZeroAddress, "0x")).to.revertedWithCustomError(
        vault1WithNewImpl,
        "VaultAlreadyInitialized",
      );
      await expect(vault1WithNewImpl.finalizeUpgrade_v2()).to.emit(vault1WithNewImpl, "InitializedV2");
    });

    it("new vaults - init works, finalize not works ", async () => {
      await beacon.connect(admin).upgradeTo(implNew);

      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);
      const { vault: vault2 } = await createVaultProxy(
        vaultOwner1,
        vaultFactory,
        vaultOwner1,
        operator,
        operator,
        200n,
        days(7n),
        [],
        "0x",
      );

      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);

      await expect(vault2.initialize(ZeroAddress, ZeroAddress, ZeroAddress, "0x")).to.revertedWithCustomError(
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
