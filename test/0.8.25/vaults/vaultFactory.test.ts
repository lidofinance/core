import { expect } from "chai";
import { keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconProxy,
  Delegation,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OssifiableProxy,
  PredepositGuarantee_HarnessForFactory,
  StakingVault,
  StakingVault__HarnessForTestUpgrade,
  StETH__HarnessForVaultHub,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";
import { DelegationConfigStruct } from "typechain-types/contracts/0.8.25/vaults/VaultFactory";

import { createVaultProxy, days, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, VAULTS_CONNECTED_VAULTS_LIMIT, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

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
  let delegation: Delegation;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;

  let locator: LidoLocator;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;

  let vaultBeaconProxy: BeaconProxy;
  let vaultBeaconProxyCode: string;

  let originalState: string;

  let delegationParams: DelegationConfigStruct;

  before(async () => {
    [deployer, admin, holder, operator, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    //predeposit guarantee
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
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

    // Accounting
    vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      steth,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);
    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, admin, new Uint8Array()], admin);
    vaultHub = await ethers.getContractAt("VaultHub", proxy, deployer);
    await vaultHub.initialize(admin);

    //vault implementation
    implOld = await ethers.deployContract("StakingVault", [predepositGuarantee, depositContract], {
      from: deployer,
    });
    implNew = await ethers.deployContract(
      "StakingVault__HarnessForTestUpgrade",
      [predepositGuarantee, depositContract],
      {
        from: deployer,
      },
    );

    //beacon
    beacon = await ethers.deployContract("UpgradeableBeacon", [implOld, admin]);

    vaultBeaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
    vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());

    delegation = await ethers.deployContract("Delegation", [weth, locator], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [beacon, delegation, vaultHub], { from: deployer });

    //add VAULT_MASTER_ROLE role to allow admin to connect the Vaults to the vault Hub
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);
    //add VAULT_REGISTRY_ROLE role to allow admin to add factory and vault implementation to the hub
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, operator, vaultHub, "0x")).to.revertedWithCustomError(
      implOld,
      "InvalidInitialization",
    );

    delegationParams = {
      defaultAdmin: await admin.getAddress(),
      nodeOperatorManager: await operator.getAddress(),
      confirmExpiry: days(7n),
      nodeOperatorFeeBP: 200n,
      funders: [await vaultOwner1.getAddress()],
      withdrawers: [await vaultOwner1.getAddress()],
      minters: [await vaultOwner1.getAddress()],
      burners: [await vaultOwner1.getAddress()],
      nodeOperatorFeeClaimers: [await operator.getAddress()],
      rebalancers: [await vaultOwner1.getAddress()],
      depositPausers: [await vaultOwner1.getAddress()],
      depositResumers: [await vaultOwner1.getAddress()],
      validatorExitRequesters: [await vaultOwner1.getAddress()],
      validatorWithdrawalTriggerers: [await vaultOwner1.getAddress()],
      disconnecters: [await vaultOwner1.getAddress()],
      assetRecoverer: await vaultOwner1.getAddress(),
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
      await expect(ethers.deployContract("VaultFactory", [ZeroAddress, delegation, vaultHub], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_beacon");
    });

    it("reverts if `_delegation` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [beacon, ZeroAddress, vaultHub], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_delegation");
    });

    it("reverts if `_vaultHub` is zero address", async () => {
      await expect(ethers.deployContract("VaultFactory", [beacon, delegation, ZeroAddress], { from: deployer }))
        .to.be.revertedWithCustomError(vaultFactory, "ZeroArgument")
        .withArgs("_vaultHub");
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
      const vaultsBefore = await vaultHub.vaultsCount();
      expect(vaultsBefore).to.eq(0);

      const config1 = {
        shareLimit: 10n,
        minReserveRatioBP: 500n,
        rebalanceThresholdBP: 20n,
        treasuryFeeBP: 500n,
      };
      const config2 = {
        shareLimit: 20n,
        minReserveRatioBP: 200n,
        rebalanceThresholdBP: 20n,
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
        vaultHub
          .connect(admin)
          .connectVault(
            await vault1.getAddress(),
            config1.shareLimit,
            config1.minReserveRatioBP,
            config1.rebalanceThresholdBP,
            config1.treasuryFeeBP,
          ),
      ).to.revertedWithCustomError(vaultHub, "VaultProxyNotAllowed");

      const vaultProxyCodeHash = keccak256(vaultBeaconProxyCode);

      //add proxy code hash to whitelist
      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);

      //connect vault 1 to VaultHub
      await vaultHub
        .connect(admin)
        .connectVault(
          await vault1.getAddress(),
          config1.shareLimit,
          config1.minReserveRatioBP,
          config1.rebalanceThresholdBP,
          config1.treasuryFeeBP,
        );

      const vaultsAfter = await vaultHub.vaultsCount();
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
        vaultHub
          .connect(admin)
          .connectVault(
            await vault2.getAddress(),
            config2.shareLimit,
            config2.minReserveRatioBP,
            config2.rebalanceThresholdBP,
            config2.treasuryFeeBP,
          ),
      ).to.not.revertedWithCustomError(vaultHub, "VaultProxyNotAllowed");

      const vault1WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault1, deployer);
      const vault2WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault2, deployer);
      const vault3WithNewImpl = await ethers.getContractAt("StakingVault__HarnessForTestUpgrade", vault3, deployer);

      //finalize first vault
      await vault1WithNewImpl.finalizeUpgrade_v2();

      //try to initialize the second vault
      await expect(vault2WithNewImpl.initialize(admin, operator, vaultHub, "0x")).to.revertedWithCustomError(
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

      await expect(vault1.initialize(ZeroAddress, ZeroAddress, ZeroAddress, "0x")).to.revertedWithCustomError(
        vault1WithNewImpl,
        "VaultAlreadyInitialized",
      );
      await expect(vault1WithNewImpl.finalizeUpgrade_v2()).to.emit(vault1WithNewImpl, "InitializedV2");
    });

    it("new vaults - init works, finalize not works ", async () => {
      await beacon.connect(admin).upgradeTo(implNew);

      const { vault: vault2 } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);

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
