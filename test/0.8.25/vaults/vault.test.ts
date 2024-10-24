import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Snapshot } from "test/suite";
import {
  DepositContract__MockForBeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor__factory,
  VaultHub__MockForVault,
  VaultHub__MockForVault__factory,
} from "typechain-types";
import { Vault } from "typechain-types/contracts/0.8.25/vaults";
import { Vault__factory } from "typechain-types/factories/contracts/0.8.25/vaults";

describe.only("Basic vault", async () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;

  let vaultHub: VaultHub__MockForVault;
  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let vault: Vault;

  let originalState: string;

  before(async () => {
    [deployer, owner] = await ethers.getSigners();

    const vaultHubFactory = new VaultHub__MockForVault__factory(deployer);
    const vaultHub = await vaultHubFactory.deploy();

    const depositContractFactory = new DepositContract__MockForBeaconChainDepositor__factory(deployer);
    depositContract = await depositContractFactory.deploy();

    const vaultFactory = new Vault__factory(owner);
    vault = await vaultFactory.deploy(
      await owner.getAddress(),
      await vaultHub.getAddress(),
      await depositContract.getAddress(),
    );

    expect(await vault.owner()).to.equal(await owner.getAddress());
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  describe("receive", () => {
    it("test", async () => {});
  });
});
