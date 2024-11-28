import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { advanceChainTime, certainAddress, days, proxify } from "lib";
import { Snapshot } from "test/suite";
import { StakingVault__MockForVaultDelegationLayer, StVaultOwnerWithDelegation } from "typechain-types";

describe("VaultDelegationLayer:Voting", () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let lidoDao: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let stakingVault: StakingVault__MockForVaultDelegationLayer;
  let stVaultOwnerWithDelegation: StVaultOwnerWithDelegation;

  let originalState: string;

  before(async () => {
    [deployer, owner, manager, operator, lidoDao, stranger] = await ethers.getSigners();

    const steth = certainAddress("vault-delegation-layer-voting-steth");
    stakingVault = await ethers.deployContract("StakingVault__MockForVaultDelegationLayer");
    const impl = await ethers.deployContract("StVaultOwnerWithDelegation", [steth]);
    // use a regular proxy for now
    [stVaultOwnerWithDelegation] = await proxify<StVaultOwnerWithDelegation>({ impl, admin: owner, caller: deployer });

    await stVaultOwnerWithDelegation.initialize(owner, stakingVault);
    expect(await stVaultOwnerWithDelegation.isInitialized()).to.be.true;
    expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.DEFAULT_ADMIN_ROLE(), owner)).to.be.true;
    expect(await stVaultOwnerWithDelegation.vaultHub()).to.equal(await stakingVault.vaultHub());

    await stakingVault.initialize(await stVaultOwnerWithDelegation.getAddress());

    stVaultOwnerWithDelegation = stVaultOwnerWithDelegation.connect(owner);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  describe("setPerformanceFee", () => {
    it("reverts if the caller does not have the required role", async () => {
      expect(stVaultOwnerWithDelegation.connect(stranger).setPerformanceFee(100)).to.be.revertedWithCustomError(
        stVaultOwnerWithDelegation,
        "NotACommitteeMember",
      );
    });

    it("executes if called by all distinct committee members", async () => {
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager);
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.connect(lidoDao).grantRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator);

      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator)).to.be.true;

      const previousFee = await stVaultOwnerWithDelegation.performanceFee();
      const newFee = previousFee + 1n;

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(manager).setPerformanceFee(newFee);
      expect(await stVaultOwnerWithDelegation.performanceFee()).to.equal(previousFee);

      // updated
      await stVaultOwnerWithDelegation.connect(operator).setPerformanceFee(newFee);
      expect(await stVaultOwnerWithDelegation.performanceFee()).to.equal(newFee);
    });

    it("executes if called by a single member with all roles", async () => {
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager);
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.connect(lidoDao).grantRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), manager);

      const previousFee = await stVaultOwnerWithDelegation.performanceFee();
      const newFee = previousFee + 1n;

      // updated with a single transaction
      await stVaultOwnerWithDelegation.connect(manager).setPerformanceFee(newFee);
      expect(await stVaultOwnerWithDelegation.performanceFee()).to.equal(newFee);
    })

    it("does not execute if the vote is expired", async () => {
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager);
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.connect(lidoDao).grantRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator);

      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator)).to.be.true;

      const previousFee = await stVaultOwnerWithDelegation.performanceFee();
      const newFee = previousFee + 1n;

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(manager).setPerformanceFee(newFee);
      expect(await stVaultOwnerWithDelegation.performanceFee()).to.equal(previousFee);

      await advanceChainTime(days(7n) + 1n);

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(operator).setPerformanceFee(newFee);
      expect(await stVaultOwnerWithDelegation.performanceFee()).to.equal(previousFee);
    });
  });


  describe("transferStakingVaultOwnership", () => {
    it("reverts if the caller does not have the required role", async () => {
      expect(stVaultOwnerWithDelegation.connect(stranger).transferStVaultOwnership(certainAddress("vault-delegation-layer-voting-new-owner"))).to.be.revertedWithCustomError(
        stVaultOwnerWithDelegation,
        "NotACommitteeMember",
      );
    });

    it("executes if called by all distinct committee members", async () => {
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager);
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.connect(lidoDao).grantRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator);

      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator)).to.be.true;

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(manager).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(stVaultOwnerWithDelegation);

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(operator).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(stVaultOwnerWithDelegation);

      // updated
      await stVaultOwnerWithDelegation.connect(lidoDao).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(newOwner);
    });

    it("executes if called by a single member with all roles", async () => {
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.connect(lidoDao).grantRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), lidoDao);

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // updated with a single transaction
      await stVaultOwnerWithDelegation.connect(lidoDao).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(newOwner);
    })

    it("does not execute if the vote is expired", async () => {
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager);
      await stVaultOwnerWithDelegation.grantRole(await stVaultOwnerWithDelegation.LIDO_DAO_ROLE(), lidoDao);
      await stVaultOwnerWithDelegation.connect(lidoDao).grantRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator);

      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await stVaultOwnerWithDelegation.hasRole(await stVaultOwnerWithDelegation.OPERATOR_ROLE(), operator)).to.be.true;

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(manager).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(stVaultOwnerWithDelegation);

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(operator).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(stVaultOwnerWithDelegation);

      await advanceChainTime(days(7n) + 1n);

      // remains unchanged
      await stVaultOwnerWithDelegation.connect(lidoDao).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(stVaultOwnerWithDelegation);
    });
  });
});
