import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  Delegation,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OssifiableProxy,
  StakingVault,
  StETH__HarnessForVaultHub,
  VaultFactory,
} from "typechain-types";

import { certainAddress, createVaultProxy, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Delegation.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let lidoAgent: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let proxy: OssifiableProxy;
  let accountingImpl: Accounting;
  let accounting: Accounting;
  let implOld: StakingVault;
  let delegation: Delegation;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;

  let locator: LidoLocator;

  let originalState: string;

  const treasury = certainAddress("treasury");

  before(async () => {
    [deployer, admin, holder, stranger, vaultOwner1, lidoAgent] = await ethers.getSigners();

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
    delegation = await ethers.deployContract("Delegation", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, delegation], { from: deployer });

    //add role to factory
    await accounting.connect(admin).grantRole(await accounting.VAULT_MASTER_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, "0x")).to.revertedWithCustomError(implOld, "SenderShouldBeBeacon");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("performanceDue", () => {
    it("performanceDue ", async () => {
      const { delegation: delegation_ } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await delegation_.performanceDue();
    });
  });

  context("initialize", async () => {
    it("reverts if initialize from implementation", async () => {
      await expect(delegation.initialize(admin, implOld)).to.revertedWithCustomError(
        delegation,
        "NonProxyCallsForbidden",
      );
    });

    it("reverts if already initialized", async () => {
      const { vault: vault1, delegation: delegation_ } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await expect(delegation_.initialize(admin, vault1)).to.revertedWithCustomError(
        delegation,
        "AlreadyInitialized",
      );
    });

    it("initialize", async () => {
      const { tx, delegation: delegation_ } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await expect(tx).to.emit(delegation_, "Initialized");
    });
  });
});
