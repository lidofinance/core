import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  OssifiableProxy,
  StakingVault,
  StETH__HarnessForVaultHub,
  VaultFactory,
  VaultStaffRoom,
} from "typechain-types";

import { certainAddress, createVaultProxy, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultStaffRoom.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let proxy: OssifiableProxy;
  let accountingImpl: Accounting;
  let accounting: Accounting;
  let implOld: StakingVault;
  let vaultStaffRoom: VaultStaffRoom;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;

  let locator: LidoLocator;

  let originalState: string;

  const treasury = certainAddress("treasury");

  before(async () => {
    [deployer, admin, holder, stranger, vaultOwner1] = await ethers.getSigners();

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
    vaultStaffRoom = await ethers.deployContract("VaultStaffRoom", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, vaultStaffRoom], { from: deployer });

    //add role to factory
    await accounting.connect(admin).grantRole(await accounting.VAULT_MASTER_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, "0x")).to.revertedWithCustomError(implOld, "UnauthorizedSender");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("performanceDue", () => {
    it("performanceDue ", async () => {
      const { vaultStaffRoom: vsr } = await createVaultProxy(vaultFactory, vaultOwner1);

      await vsr.performanceDue();
    });
  });

  context("initialize", async () => {
    it("reverts if initialize from implementation", async () => {
      await expect(vaultStaffRoom.initialize(admin, implOld)).to.revertedWithCustomError(
        vaultStaffRoom,
        "NonProxyCallsForbidden",
      );
    });

    it("reverts if already initialized", async () => {
      const { vault: vault1, vaultStaffRoom: vsr } = await createVaultProxy(vaultFactory, vaultOwner1);

      await expect(vsr.initialize(admin, vault1)).to.revertedWithCustomError(vsr, "AlreadyInitialized");
    });

    it("initialize", async () => {
      const { tx, vaultStaffRoom: vsr } = await createVaultProxy(vaultFactory, vaultOwner1);

      await expect(tx).to.emit(vsr, "Initialized");
    });
  });
});
