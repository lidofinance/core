import { expect } from "chai";
import { keccak256 } from "ethers";
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

import { createVaultProxy, days, ether, impersonate } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

describe("VaultHub.sol:deauthorize", () => {
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
  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
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

    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], { value: ether("10000.0") });
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

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

    delegation = await ethers.deployContract("Delegation", [weth, locator], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [locator, beacon, delegation], {
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

    //add proxy code hash to whitelist
    const vaultProxyCodeHash = keccak256(vaultBeaconProxyCode);
    await vaultHub.connect(admin).addVaultProxyCodehash(vaultProxyCodeHash);

    delegationParams = {
      defaultAdmin: await admin.getAddress(),
      nodeOperatorManager: await operator.getAddress(),
      assetRecoverer: await vaultOwner1.getAddress(),
      confirmExpiry: days(7n),
      nodeOperatorFeeBP: 200n,
      funders: [await vaultOwner1.getAddress()],
      withdrawers: [await vaultOwner1.getAddress()],
      lockers: [await vaultOwner1.getAddress()],
      minters: [await vaultOwner1.getAddress()],
      burners: [await vaultOwner1.getAddress()],
      rebalancers: [await vaultOwner1.getAddress()],
      depositPausers: [await vaultOwner1.getAddress()],
      depositResumers: [await vaultOwner1.getAddress()],
      validatorExitRequesters: [await vaultOwner1.getAddress()],
      validatorWithdrawalTriggerers: [await vaultOwner1.getAddress()],
      disconnecters: [await vaultOwner1.getAddress()],
      lidoVaultHubDeauthorizers: [await vaultOwner1.getAddress()],
      nodeOperatorFeeClaimers: [await operator.getAddress()],
      nodeOperatorRewardAdjusters: [await operator.getAddress()],
      pdgCompensators: [await vaultOwner1.getAddress()],
      unguaranteedBeaconChainDepositors: [await vaultOwner1.getAddress()],
      unknownValidatorProvers: [await vaultOwner1.getAddress()],
    };
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("deauthorization flow", () => {
    it("authorize=on, authorize=off", async () => {
      const { vault, delegation: _delegation } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);
      const delegationSigner = await impersonate(await _delegation.getAddress(), ether("100"));

      expect(await vault.vaultHubAuthorized()).to.equal(true);
      await vault.connect(delegationSigner).deauthorizeLidoVaultHub();
      expect(await vault.vaultHubAuthorized()).to.equal(false);
    });

    it("authorize=on, connect vault, authorize=exception", async () => {
      const { vault, delegation: _delegation } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);
      const delegationSigner = await impersonate(await _delegation.getAddress(), ether("100"));

      expect(await vault.vaultHubAuthorized()).to.equal(true);

      await vaultHub
        .connect(admin)
        .connectVault(vault, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);
      await expect(vault.connect(delegationSigner).deauthorizeLidoVaultHub()).to.revertedWithCustomError(
        vault,
        "VaultConnected",
      );
    });

    it("authorize=on, connect vault, pendingDisonnect, authorize=exception", async () => {
      const { vault, delegation: _delegation } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);
      const delegationSigner = await impersonate(await _delegation.getAddress(), ether("100"));

      expect(await vault.vaultHubAuthorized()).to.equal(true);

      await vaultHub
        .connect(admin)
        .connectVault(vault, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);
      await vaultHub.connect(delegationSigner).voluntaryDisconnect(vault);
      await expect(vault.connect(delegationSigner).deauthorizeLidoVaultHub()).to.revertedWithCustomError(
        vault,
        "VaultConnected",
      );
    });

    it("authorize=on, connect vault, pendingDisonnect, report, authorize=off", async () => {
      const { vault, delegation: _delegation } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);
      const delegationSigner = await impersonate(await _delegation.getAddress(), ether("100"));
      const accountingSigner = await impersonate(await locator.accounting(), ether("100"));

      expect(await vault.vaultHubAuthorized()).to.equal(true);

      await vaultHub
        .connect(admin)
        .connectVault(vault, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);
      await vaultHub.connect(delegationSigner).voluntaryDisconnect(vault);
      await vaultHub.connect(accountingSigner).updateVaults([1n], [1n], [1n], [0n]);
      await vault.connect(delegationSigner).deauthorizeLidoVaultHub();
      expect(await vault.vaultHubAuthorized()).to.equal(false);
    });
  });

  context("ossification", () => {
    it("ossify works on deauthorized vault", async () => {
      const {
        vault,
        delegation: _delegation,
        proxy: proxy1,
      } = await createVaultProxy(vaultOwner1, vaultFactory, delegationParams);
      const { proxy: proxy2 } = await createVaultProxy(vaultOwner2, vaultFactory, delegationParams);

      const delegationSigner = await impersonate(await _delegation.getAddress(), ether("100"));

      await vault.connect(delegationSigner).deauthorizeLidoVaultHub();
      await expect(vault.connect(delegationSigner).ossifyStakingVault()).to.emit(vault, "PinnedImplementationUpdated");

      const vault1ImplementationAfterOssify = await proxy1.implementation();
      const vault2ImplementationAfterOssify = await proxy2.implementation();

      expect(vault1ImplementationAfterOssify).to.equal(vault2ImplementationAfterOssify);

      //upgrade beacon to new implementation
      await beacon.connect(admin).upgradeTo(implNew);

      const vault1ImplementationAfterUpgrade = await proxy1.implementation();
      const vault2ImplementationAfterUpgrade = await proxy2.implementation();

      expect(vault1ImplementationAfterUpgrade).to.equal(implOld);
      expect(vault2ImplementationAfterUpgrade).to.equal(implNew);
      expect(vault1ImplementationAfterUpgrade).not.to.equal(vault2ImplementationAfterUpgrade);
    });
  });
});
