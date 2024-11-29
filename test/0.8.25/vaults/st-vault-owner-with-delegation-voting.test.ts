import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { advanceChainTime, certainAddress, days, proxify } from "lib";
import { Snapshot } from "test/suite";
import { StakingVault__MockForVaultDelegationLayer, Delegation } from "typechain-types";

describe("Delegation:Voting", () => {
  let deployer: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let manager: HardhatEthersSigner;
  let operator: HardhatEthersSigner;
  let lidoDao: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let stakingVault: StakingVault__MockForVaultDelegationLayer;
  let delegation: Delegation;

  let originalState: string;

  before(async () => {
    [deployer, owner, manager, operator, lidoDao, stranger] = await ethers.getSigners();

    const steth = certainAddress("vault-delegation-layer-voting-steth");
    stakingVault = await ethers.deployContract("StakingVault__MockForVaultDelegationLayer");
    const impl = await ethers.deployContract("Delegation", [steth]);
    // use a regular proxy for now
    [delegation] = await proxify<Delegation>({ impl, admin: owner, caller: deployer });

    await delegation.initialize(owner, stakingVault);
    expect(await delegation.isInitialized()).to.be.true;
    expect(await delegation.hasRole(await delegation.DEFAULT_ADMIN_ROLE(), owner)).to.be.true;
    expect(await delegation.vaultHub()).to.equal(await stakingVault.vaultHub());

    await stakingVault.initialize(await delegation.getAddress());

    delegation = delegation.connect(owner);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  describe("setPerformanceFee", () => {
    it("reverts if the caller does not have the required role", async () => {
      expect(delegation.connect(stranger).setPerformanceFee(100)).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("executes if called by all distinct committee members", async () => {
      await delegation.grantRole(await delegation.MANAGER_ROLE(), manager);
      await delegation.grantRole(await delegation.LIDO_DAO_ROLE(), lidoDao);
      await delegation.connect(lidoDao).grantRole(await delegation.OPERATOR_ROLE(), operator);

      expect(await delegation.hasRole(await delegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;

      const previousFee = await delegation.performanceFee();
      const newFee = previousFee + 1n;

      // remains unchanged
      await delegation.connect(manager).setPerformanceFee(newFee);
      expect(await delegation.performanceFee()).to.equal(previousFee);

      // updated
      await delegation.connect(operator).setPerformanceFee(newFee);
      expect(await delegation.performanceFee()).to.equal(newFee);
    });

    it("executes if called by a single member with all roles", async () => {
      await delegation.grantRole(await delegation.MANAGER_ROLE(), manager);
      await delegation.grantRole(await delegation.LIDO_DAO_ROLE(), lidoDao);
      await delegation.connect(lidoDao).grantRole(await delegation.OPERATOR_ROLE(), manager);

      const previousFee = await delegation.performanceFee();
      const newFee = previousFee + 1n;

      // updated with a single transaction
      await delegation.connect(manager).setPerformanceFee(newFee);
      expect(await delegation.performanceFee()).to.equal(newFee);
    })

    it("does not execute if the vote is expired", async () => {
      await delegation.grantRole(await delegation.MANAGER_ROLE(), manager);
      await delegation.grantRole(await delegation.LIDO_DAO_ROLE(), lidoDao);
      await delegation.connect(lidoDao).grantRole(await delegation.OPERATOR_ROLE(), operator);

      expect(await delegation.hasRole(await delegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;

      const previousFee = await delegation.performanceFee();
      const newFee = previousFee + 1n;

      // remains unchanged
      await delegation.connect(manager).setPerformanceFee(newFee);
      expect(await delegation.performanceFee()).to.equal(previousFee);

      await advanceChainTime(days(7n) + 1n);

      // remains unchanged
      await delegation.connect(operator).setPerformanceFee(newFee);
      expect(await delegation.performanceFee()).to.equal(previousFee);
    });
  });


  describe("transferStakingVaultOwnership", () => {
    it("reverts if the caller does not have the required role", async () => {
      expect(delegation.connect(stranger).transferStVaultOwnership(certainAddress("vault-delegation-layer-voting-new-owner"))).to.be.revertedWithCustomError(
        delegation,
        "NotACommitteeMember",
      );
    });

    it("executes if called by all distinct committee members", async () => {
      await delegation.grantRole(await delegation.MANAGER_ROLE(), manager);
      await delegation.grantRole(await delegation.LIDO_DAO_ROLE(), lidoDao);
      await delegation.connect(lidoDao).grantRole(await delegation.OPERATOR_ROLE(), operator);

      expect(await delegation.hasRole(await delegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // remains unchanged
      await delegation.connect(manager).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(delegation);

      // remains unchanged
      await delegation.connect(operator).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(delegation);

      // updated
      await delegation.connect(lidoDao).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(newOwner);
    });

    it("executes if called by a single member with all roles", async () => {
      await delegation.grantRole(await delegation.MANAGER_ROLE(), lidoDao);
      await delegation.grantRole(await delegation.LIDO_DAO_ROLE(), lidoDao);
      await delegation.connect(lidoDao).grantRole(await delegation.OPERATOR_ROLE(), lidoDao);

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // updated with a single transaction
      await delegation.connect(lidoDao).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(newOwner);
    })

    it("does not execute if the vote is expired", async () => {
      await delegation.grantRole(await delegation.MANAGER_ROLE(), manager);
      await delegation.grantRole(await delegation.LIDO_DAO_ROLE(), lidoDao);
      await delegation.connect(lidoDao).grantRole(await delegation.OPERATOR_ROLE(), operator);

      expect(await delegation.hasRole(await delegation.MANAGER_ROLE(), manager)).to.be.true;
      expect(await delegation.hasRole(await delegation.OPERATOR_ROLE(), operator)).to.be.true;

      const newOwner = certainAddress("vault-delegation-layer-voting-new-owner");

      // remains unchanged
      await delegation.connect(manager).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(delegation);

      // remains unchanged
      await delegation.connect(operator).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(delegation);

      await advanceChainTime(days(7n) + 1n);

      // remains unchanged
      await delegation.connect(lidoDao).transferStVaultOwnership(newOwner);
      expect(await stakingVault.owner()).to.equal(delegation);
    });
  });
});
