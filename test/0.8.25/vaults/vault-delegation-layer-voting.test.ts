import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { advanceChainTime, certainAddress, days, proxify } from "lib";
import { Snapshot } from "test/suite";
import { StakingVault__MockForVaultDelegationLayer, VaultDelegationLayer } from "typechain-types";

describe.only("VaultDelegationLayer:Voting", () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let lidoDao: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let stakingVault: StakingVault__MockForVaultDelegationLayer;
  let vaultDelegationLayer: VaultDelegationLayer;

  let originalState: string;

  before(async () => {
    [deployer, owner, manager, operator, lidoDao, stranger] = await ethers.getSigners();

    const steth = certainAddress("vault-delegation-layer-voting-steth");
    stakingVault = await ethers.deployContract("StakingVault__MockForVaultDelegationLayer");
    const impl = await ethers.deployContract("VaultDelegationLayer", [steth]);
    // use a regular proxy for now
    [vaultDelegationLayer] = await proxify<VaultDelegationLayer>({ impl, admin: owner, caller: deployer });

    await vaultDelegationLayer.initialize(owner, stakingVault);
    expect(await vaultDelegationLayer.isInitialized()).to.be.true;
    expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.OWNER(), owner)).to.be.true;
    expect(await vaultDelegationLayer.vaultHub()).to.equal(await stakingVault.vaultHub());

    await stakingVault.initialize(await vaultDelegationLayer.getAddress());

    vaultDelegationLayer = vaultDelegationLayer.connect(owner);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  describe("setPerformanceFee", () => {
    it("reverts if the caller does not have the required role", async () => {
      expect(vaultDelegationLayer.connect(stranger).setPerformanceFee(100)).to.be.revertedWithCustomError(
        vaultDelegationLayer,
        "UnauthorizedCaller",
      );
    });

    it("executes if called by all distinct committee members", async () => {
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.MANAGER_ROLE(), manager);
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.LIDO_DAO_ROLE(), lidoDao);
      await vaultDelegationLayer.connect(lidoDao).grantRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator);

      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.MANAGER_ROLE(), manager)).to.be.true;
      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator)).to.be.true;

      const previousFee = await vaultDelegationLayer.performanceFee();
      const newFee = previousFee + 1n;

      // remains unchanged
      await vaultDelegationLayer.connect(manager).setPerformanceFee(newFee);
      expect(await vaultDelegationLayer.performanceFee()).to.equal(previousFee);

      // updated
      await vaultDelegationLayer.connect(operator).setPerformanceFee(newFee);
      expect(await vaultDelegationLayer.performanceFee()).to.equal(newFee);
    });

    it("executes if called by a single member with all roles", async () => {
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.MANAGER_ROLE(), manager);
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.LIDO_DAO_ROLE(), lidoDao);
      await vaultDelegationLayer.connect(lidoDao).grantRole(await vaultDelegationLayer.OPERATOR_ROLE(), manager);

      const previousFee = await vaultDelegationLayer.performanceFee();
      const newFee = previousFee + 1n;

      // updated with a single transaction
      await vaultDelegationLayer.connect(manager).setPerformanceFee(newFee);
      expect(await vaultDelegationLayer.performanceFee()).to.equal(newFee);
    })

    it("does not execute if the vote is expired", async () => {
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.MANAGER_ROLE(), manager);
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.LIDO_DAO_ROLE(), lidoDao);
      await vaultDelegationLayer.connect(lidoDao).grantRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator);

      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.MANAGER_ROLE(), manager)).to.be.true;
      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator)).to.be.true;

      const previousFee = await vaultDelegationLayer.performanceFee();
      const newFee = previousFee + 1n;

      // remains unchanged
      await vaultDelegationLayer.connect(manager).setPerformanceFee(newFee);
      expect(await vaultDelegationLayer.performanceFee()).to.equal(previousFee);

      await advanceChainTime(days(7n) + 1n);

      // remains unchanged
      await vaultDelegationLayer.connect(operator).setPerformanceFee(newFee);
      expect(await vaultDelegationLayer.performanceFee()).to.equal(previousFee);
    });
  });


  describe("transferStakingVaultOwnership", () => {
    it("reverts if the caller does not have the required role", async () => {
      expect(vaultDelegationLayer.connect(stranger).transferStakingVaultOwnership(certainAddress("vault-delegation-layer-voting-new-owner"))).to.be.revertedWithCustomError(
        vaultDelegationLayer,
        "UnauthorizedCaller",
      );
    });

    it("executes if called by all distinct committee members", async () => {
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.MANAGER_ROLE(), manager);
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.LIDO_DAO_ROLE(), lidoDao);
      await vaultDelegationLayer.connect(lidoDao).grantRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator);

      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.MANAGER_ROLE(), manager)).to.be.true;
      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator)).to.be.true;

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // remains unchanged
      await vaultDelegationLayer.connect(manager).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(vaultDelegationLayer);

      // remains unchanged
      await vaultDelegationLayer.connect(operator).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(vaultDelegationLayer);

      // updated
      await vaultDelegationLayer.connect(lidoDao).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(newOwner);
    });

    it("executes if called by a single member with all roles", async () => {
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.MANAGER_ROLE(), lidoDao);
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.LIDO_DAO_ROLE(), lidoDao);
      await vaultDelegationLayer.connect(lidoDao).grantRole(await vaultDelegationLayer.OPERATOR_ROLE(), lidoDao);

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // updated with a single transaction
      await vaultDelegationLayer.connect(lidoDao).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(newOwner);
    })

    it("does not execute if the vote is expired", async () => {
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.MANAGER_ROLE(), manager);
      await vaultDelegationLayer.grantRole(await vaultDelegationLayer.LIDO_DAO_ROLE(), lidoDao);
      await vaultDelegationLayer.connect(lidoDao).grantRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator);

      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.MANAGER_ROLE(), manager)).to.be.true;
      expect(await vaultDelegationLayer.hasRole(await vaultDelegationLayer.OPERATOR_ROLE(), operator)).to.be.true;

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // remains unchanged
      await vaultDelegationLayer.connect(manager).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(vaultDelegationLayer);

      // remains unchanged
      await vaultDelegationLayer.connect(operator).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(vaultDelegationLayer);

      await advanceChainTime(days(7n) + 1n);

      // remains unchanged
      await vaultDelegationLayer.connect(lidoDao).transferStakingVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(vaultDelegationLayer);
    });
  });
});
