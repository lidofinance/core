import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  LidoLocator,
  StakingVault,
  StakingVault__factory,
  StakingVault__MockForVault,
  StakingVault__MockForVault__factory,
  StETH__Harness,
  VaultFactory,
  VaultHub,
} from "typechain-types";

import { ArrayToUnion, certainAddress, ether, findEventsWithInterfaces, randomAddress } from "lib";

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

interface Vault {
  admin: string;
  vault: string;
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
  let implOld: StakingVault;
  let implNew: StakingVault__Harness;
  let vaultFactory: VaultFactory;

  let steth: StETH__Harness;

  const config = randomConfig();
  let locator: LidoLocator;

  //create vault from factory
  async function createVaultProxy(_owner: HardhatEthersSigner): Promise<Vault> {
    const tx = await vaultFactory.connect(_owner).createVault();
    await expect(tx).to.emit(vaultFactory, "VaultCreated");

    // Get the receipt manually
    const receipt = (await tx.wait())!;
    const events = findEventsWithInterfaces(receipt, "VaultCreated", [vaultFactory.interface]);

    // If no events found, return undefined
    if (events.length === 0) return {
        admin: '',
        vault: '',
    };

    // Get the first event
    const event = events[0];

    // Extract the event arguments
    const { vault, admin: vaultAdmin } = event.args;

    // Create and return the Vault object
    return {
      admin: vaultAdmin,
      vault: vault,
    };
  }

  const treasury = certainAddress("treasury");

  beforeEach(async () => {
    [deployer, admin, holder, stranger, vaultOwner1, vaultOwner2] = await ethers.getSigners();

    locator = await ethers.deployContract("LidoLocator", [config], deployer);
    steth = await ethers.deployContract("StETH__Harness", [holder], { value: ether("10.0"), from: deployer });
    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    //VaultHub
    vaultHub = await ethers.deployContract("VaultHub__Harness", [admin, locator, steth, treasury], { from: deployer });
    implOld = await ethers.deployContract("contracts/0.8.25/vaults/StakingVault.sol:StakingVault", [vaultHub, steth, depositContract], { from: deployer });
    implNew = await ethers.deployContract("StakingVault__MockForVault", [vaultHub, steth, depositContract], {
      from: deployer,
    });
    vaultFactory = await ethers.deployContract("VaultFactory", [implOld, admin], { from: deployer });

    //add role to factory
    // await vaultHub.connect(admin).grantRole(await vaultHub.VAULT_MASTER_ROLE(), admin);

    //the initialize() function cannot be called on a contract
    await expect(implOld.initialize(stranger)).to.revertedWithCustomError(implOld, "NonProxyCall");
  });

  context("connect", () => {
    it("connect ", async () => {
      const vaultsBefore = await vaultHub.vaultsCount();
      expect(vaultsBefore).to.eq(0);

      const config1 = {
        capShares: 10n,
        minimumBondShareBP: 500n,
        treasuryFeeBP: 500n,
      };
      const config2 = {
        capShares: 20n,
        minimumBondShareBP: 200n,
        treasuryFeeBP: 600n,
      };

      //create vault permissionless
      const vault1event = await createVaultProxy(vaultOwner1);
      const vault2event = await createVaultProxy(vaultOwner2);

      //try to connect vault without, factory not allowed
      await expect(
        vaultHub
          .connect(admin)
          .connectVault(vault1event.vault, config1.capShares, config1.minimumBondShareBP, config1.treasuryFeeBP),
      ).to.revertedWithCustomError(vaultHub, "FactoryNotAllowed");

      //add factory to whitelist
      await vaultHub.connect(admin).addFactory(vaultFactory);

      //try to connect vault without, impl not allowed
      await expect(
        vaultHub
          .connect(admin)
          .connectVault(vault1event.vault, config1.capShares, config1.minimumBondShareBP, config1.treasuryFeeBP),
      ).to.revertedWithCustomError(vaultHub, "ImplNotAllowed");

      //add impl to whitelist
      await vaultHub.connect(admin).addImpl(implOld);

      //connect vaults to VaultHub
      await vaultHub
        .connect(admin)
        .connectVault(vault1event.vault, config1.capShares, config1.minimumBondShareBP, config1.treasuryFeeBP);
      await vaultHub
        .connect(admin)
        .connectVault(vault2event.vault, config2.capShares, config2.minimumBondShareBP, config2.treasuryFeeBP);

      const vaultsAfter = await vaultHub.vaultsCount();
      expect(vaultsAfter).to.eq(2);

      const vaultContract1 = new ethers.Contract(vault1event.vault, StakingVault__factory.abi, ethers.provider);
      // const vaultContract1New = new ethers.Contract(vault1event?.vault, LiquidStakingVault__MockForTestUpgrade__factory.abi, ethers.provider);
      const vaultContract2 = new ethers.Contract(vault2event.vault, StakingVault__factory.abi, ethers.provider);

      const version1Before = await vaultContract1.version();
      const version2Before = await vaultContract2.version();

      const implBefore = await vaultFactory.implementation();
      expect(implBefore).to.eq(await implOld.getAddress());

      //upgrade beacon to new implementation
      await vaultFactory.connect(admin).upgradeTo(implNew);

      const implAfter = await vaultFactory.implementation();
      expect(implAfter).to.eq(await implNew.getAddress());

      //create new vault with new implementation
      const vault3event = await createVaultProxy(vaultOwner1);
      const vaultContract3 = new ethers.Contract(
        vault3event?.vault,
        StakingVault__MockForVault__factory.abi,
        ethers.provider,
      );

      //we upgrade implementation and do not add it to whitelist
      await expect(
        vaultHub
          .connect(admin)
          .connectVault(vault1event.vault, config1.capShares, config1.minimumBondShareBP, config1.treasuryFeeBP),
      ).to.revertedWithCustomError(vaultHub, "ImplNotAllowed");

      const version1After = await vaultContract1.version();
      const version2After = await vaultContract2.version();
      const version3After = await vaultContract3.version();

      console.log({ version1Before, version1After });
      console.log({ version2Before, version2After, version3After });

      expect(version1Before).not.to.eq(version1After);
      expect(version2Before).not.to.eq(version2After);
    });
  });
});
