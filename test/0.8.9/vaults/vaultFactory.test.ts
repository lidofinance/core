
import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  LiquidStakingVault,
  LiquidStakingVault__factory,
  LiquidStakingVault__MockForTestUpgrade,
  LiquidStakingVault__MockForTestUpgrade__factory,
  StETH__Harness,
  VaultFactory,
  VaultHub} from "typechain-types";

import { certainAddress, ether, findEventsWithInterfaces,randomAddress } from "lib";

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

interface VaultParams {
  capShares: bigint;
  minimumBondShareBP: bigint;
  treasuryFeeBP: bigint;
}

interface Vault {
  admin: string;
  vault: string;
  capShares: number;
  minimumBondShareBP: number;
  treasuryFeeBP: number;
}

describe("VaultFactory.sol", () => {

  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let vaultOwner1: HardhatEthersSigner;
  let vaultOwner2: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vaultHub: VaultHub;
  let implOld: LiquidStakingVault;
  let implNew: LiquidStakingVault__MockForTestUpgrade;
  let vaultFactory: VaultFactory;

  let steth: StETH__Harness;

  const config = randomConfig();
  let locator: LidoLocator;

  //create vault from factory
  async function createVaultProxy({
    capShares,
    minimumBondShareBP,
    treasuryFeeBP
  }:VaultParams,
    _factoryAdmin: HardhatEthersSigner,
    _owner: HardhatEthersSigner
  ): Promise<Vault | Addressable > {
    const tx = await vaultFactory.connect(_factoryAdmin).createVault(_owner, capShares, minimumBondShareBP, treasuryFeeBP)
    await expect(tx).to.emit(vaultFactory, "VaultCreated");

    // Get the receipt manually
    const receipt = (await tx.wait())!;
    const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface])

     // If no events found, return undefined
     if (events.length === 0) return;

    // Get the first event
    const event = events[0];

    // Extract the event arguments
    const { vault, admin, capShares: eventCapShares, minimumBondShareBP: eventMinimumBondShareBP, treasuryFeeBP: eventTreasuryFeeBP } = event.args;

    // Create and return the Vault object
    const createdVault: Vault = {
        admin: admin,
        vault: vault,
        capShares: eventCapShares, // Convert BigNumber to number
        minimumBondShareBP: eventMinimumBondShareBP, // Convert BigNumber to number
        treasuryFeeBP: eventTreasuryFeeBP, // Convert BigNumber to number
    };

    return createdVault;
  }

  const treasury = certainAddress("treasury")

  beforeEach(async () => {
    [deployer, admin, holder, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    locator = await ethers.deployContract("LidoLocator", [config], deployer);
    steth = await ethers.deployContract("StETH__Harness", [holder], { value: ether("10.0"), from: deployer });
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    //VaultHub
    vaultHub = await ethers.deployContract("Accounting", [admin, locator, steth, treasury], { from: deployer});
    implOld = await ethers.deployContract("LiquidStakingVault", [vaultHub, depositContract], {from: deployer});
    implNew = await ethers.deployContract("LiquidStakingVault__MockForTestUpgrade", [depositContract], {from: deployer});
    vaultFactory = await ethers.deployContract("VaultFactory", [admin, implOld, vaultHub], { from: deployer});

    //add role to factory
    await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultFactory);
  })

  context("connect", () => {
    it("connect ", async () => {

      const vaultsBefore = await vaultHub.vaultsCount()
      expect(vaultsBefore).to.eq(0)

      const config1 = {
        capShares: 10n,
        minimumBondShareBP: 500n,
        treasuryFeeBP: 500n
      }
      const config2 = {
        capShares: 20n,
        minimumBondShareBP: 200n,
        treasuryFeeBP: 600n
      }

      const vault1event = await createVaultProxy(config1, admin, vaultOwner1)
      const vault2event = await createVaultProxy(config2, admin, vaultOwner2)

      const vaultsAfter = await vaultHub.vaultsCount()

      const stakingVaultContract1 = new ethers.Contract(vault1event?.vault, LiquidStakingVault__factory.abi, ethers.provider);
      const stakingVaultContract1New = new ethers.Contract(vault1event?.vault, LiquidStakingVault__MockForTestUpgrade__factory.abi, ethers.provider);
      const stakingVaultContract2 = new ethers.Contract(vault2event?.vault, LiquidStakingVault__factory.abi, ethers.provider);

      expect(vaultsAfter).to.eq(2)

      const wc1 = await stakingVaultContract1.getWithdrawalCredentials()
      const wc2 = await stakingVaultContract2.getWithdrawalCredentials()
      const version1Before = await stakingVaultContract1.version()
      const version2Before = await stakingVaultContract2.version()

      const implBefore = await vaultFactory.implementation()
      expect(implBefore).to.eq(await implOld.getAddress())

      //upgrade beacon to new implementation
      await vaultFactory.connect(admin).upgradeTo(implNew)

      await stakingVaultContract1New.connect(stranger).finalizeUpgrade_v2()

      //create new vault with new implementation

      const vault3event = await createVaultProxy(config1, admin, vaultOwner1)
      const stakingVaultContract3 = new ethers.Contract(vault3event?.vault, LiquidStakingVault__MockForTestUpgrade__factory.abi, ethers.provider);

      const version1After = await stakingVaultContract1.version()
      const version2After = await stakingVaultContract2.version()
      const version3After = await stakingVaultContract3.version()

      const contractVersion1After = await stakingVaultContract1.getContractVersion()
      const contractVersion2After = await stakingVaultContract2.getContractVersion()
      const contractVersion3After = await stakingVaultContract3.getContractVersion()

      console.log({version1Before, version1After})
      console.log({version2Before, version2After, version3After})
      console.log({contractVersion1After, contractVersion2After, contractVersion3After})

      const tx = await stakingVaultContract3.connect(stranger).finalizeUpgrade_v2()

    });
  });
})
