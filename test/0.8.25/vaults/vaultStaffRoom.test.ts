import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  StakingVault,
  StETH__HarnessForVaultHub,
  VaultFactory,
  VaultHub,
  VaultStaffRoom
} from "typechain-types";

import { ArrayToUnion, certainAddress, createVaultProxy,ether, randomAddress } from "lib";

const services = [
  "accountingOracle",
  "depositSecurityModule",
  "elRewardsVault",
  "legacyOracle",
  "lido",
  "oracleReportSanityChecker",
  "postTokenRebaseReceiver",
  "burner",
  "stakingRouter",
  "treasury",
  "validatorsExitBusOracle",
  "withdrawalQueue",
  "withdrawalVault",
  "oracleDaemonConfig",
  "accounting",
] as const;

type Service = ArrayToUnion<typeof services>;
type Config = Record<Service, string>;

function randomConfig(): Config {
  return services.reduce<Config>((config, service) => {
    config[service] = randomAddress();
    return config;
  }, {} as Config);
}

describe("VaultFactory.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultHub: VaultHub;
  let implOld: StakingVault;
  let vaultStaffRoom: VaultStaffRoom;
  let vaultFactory: VaultFactory;

  let steth: StETH__HarnessForVaultHub;

  const config = randomConfig();
  let locator: LidoLocator;

  const treasury = certainAddress("treasury");

  beforeEach(async () => {
    [deployer, admin, holder, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    locator = await ethers.deployContract("LidoLocator", [config], deployer);
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], { value: ether("10.0"), from: deployer });
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    // VaultHub
    vaultHub = await ethers.deployContract("Accounting", [admin, locator, steth, treasury], { from: deployer });
    implOld = await ethers.deployContract("StakingVault", [vaultHub, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__HarnessForTestUpgrade", [vaultHub, depositContract], {
      from: deployer,
    });
    vaultStaffRoom = await ethers.deployContract("VaultStaffRoom", [steth], { from: deployer });
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, vaultStaffRoom], { from: deployer });

    //add role to factory
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger, "0x")).to.revertedWithCustomError(implOld, "NonProxyCallsForbidden");
  });

  context("performanceDue", () => {
    it("performanceDue ", async () => {
      const { vaultStaffRoom: vsr } = await createVaultProxy(vaultFactory, vaultOwner1);

      await vsr.performanceDue();
    })
  })

  context("initialize", async () => {
    it ("initialize", async () => {
      const { tx } = await createVaultProxy(vaultFactory, vaultOwner1);

      await expect(tx).to.emit(vaultStaffRoom, "Initialized");
    });

    it ("reverts if already initialized",  async () => {
      const { vault: vault1 } = await createVaultProxy(vaultFactory, vaultOwner1);

      await expect(vaultStaffRoom.initialize(admin, vault1))
        .to.revertedWithCustomError(vaultStaffRoom, "AlreadyInitialized");
    });
  })
})
