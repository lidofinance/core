import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  StakingVault,
  StETH__HarnessForVaultHub,
  StVaultOwnerWithDelegation,
  VaultFactory,
  VaultHub,
} from "typechain-types";

import { certainAddress, createVaultProxy, ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StVaultOwnerWithDelegation.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let lidoAgent: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultHub: VaultHub;
  let implOld: StakingVault;
  let stVaultOwnerWithDelegation: StVaultOwnerWithDelegation;
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

    // VaultHub
    vaultHub = await ethers.deployContract("Accounting", [admin, locator, steth, treasury], { from: deployer });
    implOld = await ethers.deployContract("StakingVault", [vaultHub, depositContract], { from: deployer });
    stVaultOwnerWithDelegation = await ethers.deployContract("StVaultOwnerWithDelegation", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, stVaultOwnerWithDelegation], { from: deployer });

    //add role to factory
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, "0x")).to.revertedWithCustomError(implOld, "NonProxyCallsForbidden");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("performanceDue", () => {
    it("performanceDue ", async () => {
      const { stVaultOwnerWithDelegation } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await stVaultOwnerWithDelegation.performanceDue();
    });
  });

  context("initialize", async () => {
    it("reverts if initialize from implementation", async () => {
      await expect(stVaultOwnerWithDelegation.initialize(admin, implOld)).to.revertedWithCustomError(
        stVaultOwnerWithDelegation,
        "NonProxyCallsForbidden",
      );
    });

    it("reverts if already initialized", async () => {
      const { vault: vault1, stVaultOwnerWithDelegation } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await expect(stVaultOwnerWithDelegation.initialize(admin, vault1)).to.revertedWithCustomError(
        stVaultOwnerWithDelegation,
        "AlreadyInitialized",
      );
    });

    it("initialize", async () => {
      const { tx, stVaultOwnerWithDelegation } = await createVaultProxy(vaultFactory, vaultOwner1, lidoAgent);

      await expect(tx).to.emit(stVaultOwnerWithDelegation, "Initialized");
    });
  });
});
