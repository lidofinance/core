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
  StakingVault,
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
  // let implNew: StakingVault;
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

    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    locator = await deployLidoLocator({
      lido: steth,
      wstETH: wsteth,
    });

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // Accounting
    vaultHubImpl = await ethers.deployContract("VaultHub", [
      steth,
      ZeroAddress,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);
    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, admin, new Uint8Array()], admin);
    vaultHub = await ethers.getContractAt("VaultHub", proxy, deployer);
    await vaultHub.initialize(admin);

    //vault implementation
    implOld = await ethers.deployContract("StakingVault", [depositContract], { from: deployer });
    // implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [depositContract], {
    //   from: deployer,
    // });

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
      curatorFeeBP: 100n,
      nodeOperatorFeeBP: 200n,
      funders: [await vaultOwner1.getAddress()],
      withdrawers: [await vaultOwner1.getAddress()],
      minters: [await vaultOwner1.getAddress()],
      burners: [await vaultOwner1.getAddress()],
      curatorFeeSetters: [await vaultOwner1.getAddress()],
      curatorFeeClaimers: [await vaultOwner1.getAddress()],
      nodeOperatorFeeClaimers: [await operator.getAddress()],
      rebalancers: [await vaultOwner1.getAddress()],
      depositPausers: [await vaultOwner1.getAddress()],
      depositResumers: [await vaultOwner1.getAddress()],
      validatorExitRequesters: [await vaultOwner1.getAddress()],
      validatorWithdrawalTriggerers: [await vaultOwner1.getAddress()],
      disconnecters: [await vaultOwner1.getAddress()],
    };
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("createVaultWithDelegation", () => {
    it("works with empty `params`", async () => {
      const config1 = {
        shareLimit: 10n,
        minReserveRatioBP: 500n,
        rebalanceThresholdBP: 20n,
        treasuryFeeBP: 500n,
      };

      const { vault: vault1 } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);

      //add proxy code hash to whitelist
      const vaultProxyCodeHash = keccak256(vaultBeaconProxyCode);
      await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);

      await vaultHub
        .connect(admin)
        .connectVault(
          await vault1.getAddress(),
          config1.shareLimit,
          config1.minReserveRatioBP,
          config1.rebalanceThresholdBP,
          config1.treasuryFeeBP,
        );

      const implBefore = await beacon.implementation();
      expect(implBefore).to.eq(await implOld.getAddress());

      console.log({
        beaconImplementation: implBefore,
        implOldAddress: await implOld.getAddress(),
        // implNew: await implNew.getAddress(),
        vaultOwner2: await vaultOwner2.getAddress(),
        // vaultImplementation: await vault1.implementation(),
      });
    });
  });
});
