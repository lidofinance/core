import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  PDG__MockForPermissions,
  Permissions__Harness,
  StakingVault__MockForPermissions,
  VaultHub__MockForPermissions,
} from "typechain-types";

import { ether } from "lib";
import { findEvents } from "lib/event";

import { Snapshot } from "test/suite";

describe("Permissions", () => {
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let vaultHub: VaultHub__MockForPermissions;
  let stakingVault: StakingVault__MockForPermissions;
  let permissions: Permissions__Harness;
  let pdg: PDG__MockForPermissions;

  let roles: string[] = [];

  let originalState: string;

  before(async () => {
    [owner, stranger] = await ethers.getSigners();

    pdg = await ethers.deployContract("PDG__MockForPermissions");
    vaultHub = await ethers.deployContract("VaultHub__MockForPermissions");
    stakingVault = await ethers.deployContract("StakingVault__MockForPermissions", [owner, pdg, vaultHub]);
    permissions = await ethers.deployContract("Permissions__Harness", [owner, stakingVault]);
    await stakingVault.transferOwnership(permissions);

    expect(await stakingVault.owner()).to.equal(permissions);
    expect(await stakingVault.depositor()).to.equal(pdg);
    expect(await stakingVault.vaultHub()).to.equal(vaultHub);
    expect(await permissions.stakingVault()).to.equal(stakingVault);
    expect(await permissions.vaultHub()).to.equal(vaultHub);
    expect(await permissions.hasRole(await permissions.DEFAULT_ADMIN_ROLE(), owner)).to.be.true;

    roles = await Promise.all([
      permissions.FUND_ROLE(),
      permissions.WITHDRAW_ROLE(),
      permissions.MINT_ROLE(),
      permissions.BURN_ROLE(),
      permissions.REBALANCE_ROLE(),
      permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(),
      permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(),
      permissions.REQUEST_VALIDATOR_EXIT_ROLE(),
      permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(),
      permissions.VOLUNTARY_DISCONNECT_ROLE(),
      permissions.PDG_WITHDRAWAL_ROLE(),
      permissions.ASSET_RECOVERY_ROLE(),
    ]);
  });

  beforeEach(async () => {
    originalState = await Snapshot.take();
  });

  afterEach(async () => {
    await Snapshot.restore(originalState);
  });

  context("grantRoles", () => {
    it("reverts if the assignments array is empty", async () => {
      await expect(permissions.grantRoles([]))
        .to.be.revertedWithCustomError(permissions, "ZeroArgument")
        .withArgs("_assignments");
    });

    it("reverts if the caller is not the role admin", async () => {
      const role = roles[0];
      const adminRole = await permissions.getRoleAdmin(role);
      expect(await permissions.hasRole(adminRole, stranger)).to.be.false;

      await expect(permissions.connect(stranger).grantRoles([{ role, account: stranger }]))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, adminRole);
    });

    it("grants roles to the accounts and emits events", async () => {
      const assignments = roles.map((role) => ({ role, account: owner }));

      // check that that the owner doesnt have any of the roles
      await Promise.all(roles.map(async (role) => expect(await permissions.hasRole(role, owner)).to.be.false));

      const tx = await permissions.connect(owner).grantRoles(assignments);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("No receipt found");

      const events = findEvents(receipt, "RoleGranted");
      expect(events).to.have.lengthOf(roles.length);

      for (let i = 0; i < roles.length; i++) {
        const {
          args: { role, account },
        } = events[i];
        expect(role).to.equal(roles[i]);
        expect(account).to.equal(owner);
      }

      // check that the owner has all the roles
      for (const assignment of assignments) {
        expect(await permissions.hasRole(assignment.role, assignment.account)).to.be.true;
      }
    });

    it("does not emit the event if the role is already granted", async () => {
      await permissions.connect(owner).grantRoles([{ role: roles[0], account: owner }]);
      expect(await permissions.hasRole(roles[0], owner)).to.be.true;

      await expect(permissions.connect(owner).grantRoles([{ role: roles[0], account: owner }])).not.to.emit(
        permissions,
        "RoleGranted",
      );
    });
  });

  context("revokeRoles", () => {
    it("reverts if the assignments array is empty", async () => {
      await expect(permissions.revokeRoles([]))
        .to.be.revertedWithCustomError(permissions, "ZeroArgument")
        .withArgs("_assignments");
    });

    it("reverts if the caller is not the role admin", async () => {
      const role = roles[0];
      const adminRole = await permissions.getRoleAdmin(role);
      expect(await permissions.hasRole(adminRole, stranger)).to.be.false;

      await expect(permissions.connect(stranger).revokeRoles([{ role, account: stranger }]))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, adminRole);
    });

    it("revokes roles from the accounts and emits events", async () => {
      const assignments = roles.map((role) => ({ role, account: owner }));
      await permissions.connect(owner).grantRoles(assignments);
      for (const assignment of assignments) {
        expect(await permissions.hasRole(assignment.role, assignment.account)).to.be.true;
      }

      const tx = await permissions.connect(owner).revokeRoles(assignments);
      const receipt = await tx.wait();
      if (!receipt) throw new Error("No receipt found");

      const events = findEvents(receipt, "RoleRevoked");
      expect(events).to.have.lengthOf(roles.length);

      for (let i = 0; i < roles.length; i++) {
        const {
          args: { role, account },
        } = events[i];
        expect(role).to.equal(roles[i]);
        expect(account).to.equal(owner);
      }

      for (const assignment of assignments) {
        expect(await permissions.hasRole(assignment.role, assignment.account)).to.be.false;
      }
    });

    it("does not emit the event if the role is not granted", async () => {
      expect(await permissions.hasRole(roles[0], stranger)).to.be.false;

      await expect(permissions.connect(owner).revokeRoles([{ role: roles[0], account: stranger }])).not.to.emit(
        permissions,
        "RoleRevoked",
      );
    });
  });

  context("fund", () => {
    it("reverts if the caller does not have the FUND_ROLE", async () => {
      await expect(permissions.connect(stranger).fund())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.FUND_ROLE());
    });

    it("funds the staking vault", async () => {
      await permissions.connect(owner).grantRole(await permissions.FUND_ROLE(), owner);
      const amount = ether("1");
      await expect(permissions.connect(owner).fund({ value: amount }))
        .to.emit(stakingVault, "MockFunded")
        .withArgs(permissions, amount);
    });
  });

  context("withdraw", () => {
    it("reverts if the caller does not have the WITHDRAW_ROLE", async () => {
      await expect(permissions.connect(stranger).withdraw(stranger, ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.WITHDRAW_ROLE());
    });

    it("withdraws from the staking vault", async () => {
      await permissions.connect(owner).grantRole(await permissions.WITHDRAW_ROLE(), owner);
      const amount = ether("1");
      await expect(permissions.connect(owner).withdraw(owner, amount))
        .to.emit(stakingVault, "MockWithdrawn")
        .withArgs(permissions, owner, amount);
    });
  });

  context("mintShares", () => {
    it("reverts if the caller does not have the MINT_ROLE", async () => {
      await expect(permissions.connect(stranger).mintShares(stranger, ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.MINT_ROLE());
    });

    it("mints shares to the recipient", async () => {
      await permissions.connect(owner).grantRole(await permissions.MINT_ROLE(), owner);
      const amount = ether("1");
      await expect(permissions.connect(owner).mintShares(owner, amount))
        .to.emit(vaultHub, "MockSharesMinted")
        .withArgs(permissions, stakingVault, owner, amount);
    });
  });

  context("burnShares", () => {
    it("reverts if the caller does not have the BURN_ROLE", async () => {
      await expect(permissions.connect(stranger).burnShares(ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.BURN_ROLE());
    });

    it("burns shares from the recipient", async () => {
      await permissions.connect(owner).grantRole(await permissions.BURN_ROLE(), owner);
      const amount = ether("1");
      await expect(permissions.connect(owner).burnShares(amount))
        .to.emit(vaultHub, "MockSharesBurned")
        .withArgs(permissions, stakingVault, amount);
    });
  });

  context("rebalanceVault", () => {
    it("reverts if the caller does not have the REBALANCE_ROLE", async () => {
      await expect(permissions.connect(stranger).rebalanceVault(ether("1")))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.REBALANCE_ROLE());
    });

    it("rebalances the staking vault", async () => {
      await permissions.connect(owner).grantRole(await permissions.REBALANCE_ROLE(), owner);
      const amount = ether("1");
      await expect(permissions.connect(owner).rebalanceVault(amount))
        .to.emit(stakingVault, "MockRebalanced")
        .withArgs(permissions, amount);
    });
  });

  context("pauseBeaconChainDeposits", () => {
    it("reverts if the caller does not have the PAUSE_BEACON_CHAIN_DEPOSITS_ROLE", async () => {
      await expect(permissions.connect(stranger).pauseBeaconChainDeposits())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE());
    });

    it("pauses the beacon chain deposits", async () => {
      await permissions.connect(owner).grantRole(await permissions.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE(), owner);
      await expect(permissions.connect(owner).pauseBeaconChainDeposits())
        .to.emit(stakingVault, "MockPausedBeaconChainDeposits")
        .withArgs(permissions);
    });
  });

  context("resumeBeaconChainDeposits", () => {
    it("reverts if the caller does not have the RESUME_BEACON_CHAIN_DEPOSITS_ROLE", async () => {
      await expect(permissions.connect(stranger).resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE());
    });

    it("resumes the beacon chain deposits", async () => {
      await permissions.connect(owner).grantRole(await permissions.RESUME_BEACON_CHAIN_DEPOSITS_ROLE(), owner);
      await expect(permissions.connect(owner).resumeBeaconChainDeposits())
        .to.emit(stakingVault, "MockResumedBeaconChainDeposits")
        .withArgs(permissions);
    });
  });

  context("requestValidatorExit", () => {
    it("reverts if the caller does not have the REQUEST_VALIDATOR_EXIT_ROLE", async () => {
      await expect(permissions.connect(stranger).requestValidatorExit(ethers.randomBytes(32)))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.REQUEST_VALIDATOR_EXIT_ROLE());
    });

    it("requests the validator exit", async () => {
      await permissions.connect(owner).grantRole(await permissions.REQUEST_VALIDATOR_EXIT_ROLE(), owner);
      const pubkeys = ethers.randomBytes(32);
      await expect(permissions.connect(owner).requestValidatorExit(pubkeys))
        .to.emit(stakingVault, "MockValidatorExitRequested")
        .withArgs(permissions, pubkeys);
    });
  });

  context("triggerValidatorWithdrawal", () => {
    it("reverts if the caller does not have the TRIGGER_VALIDATOR_WITHDRAWAL_ROLE", async () => {
      await expect(permissions.connect(stranger).triggerValidatorWithdrawal(ethers.randomBytes(32), [1], stranger))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE());
    });

    it("triggers the validator withdrawal", async () => {
      await permissions.connect(owner).grantRole(await permissions.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE(), owner);
      const pubkeys = ethers.randomBytes(32);
      const amounts = [ether("1")];
      const value = ether("1");
      await expect(permissions.connect(owner).triggerValidatorWithdrawal(pubkeys, amounts, owner, { value }))
        .to.emit(stakingVault, "MockValidatorWithdrawalTriggered")
        .withArgs(pubkeys, amounts, owner, permissions, value);
    });
  });

  context("requestValidatorExit", () => {
    it("reverts if the caller does not have the REQUEST_VALIDATOR_EXIT_ROLE", async () => {
      await expect(permissions.connect(stranger).requestValidatorExit(ethers.randomBytes(32)))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.REQUEST_VALIDATOR_EXIT_ROLE());
    });

    it("requests the validator exit", async () => {
      await permissions.connect(owner).grantRole(await permissions.REQUEST_VALIDATOR_EXIT_ROLE(), owner);
      const pubkeys = ethers.randomBytes(32);
      await expect(permissions.connect(owner).requestValidatorExit(pubkeys))
        .to.emit(stakingVault, "MockValidatorExitRequested")
        .withArgs(permissions, pubkeys);
    });
  });

  context("transferStakingVaultOwnership", () => {
    it("reverts if the caller is not a member of the confirming roles", async () => {
      await expect(permissions.connect(stranger).transferStakingVaultOwnership(stranger)).to.be.revertedWithCustomError(
        permissions,
        "SenderNotMember",
      );
    });

    it("transfers the staking vault ownership", async () => {
      expect(await stakingVault.owner()).to.equal(permissions);
      await expect(permissions.connect(owner).transferStakingVaultOwnership(stranger))
        .to.emit(stakingVault, "OwnershipTransferred")
        .withArgs(permissions, stranger);
    });
  });

  context("voluntaryDisconnect", () => {
    it("reverts if the caller does not have the VOLUNTARY_DISCONNECT_ROLE", async () => {
      await expect(permissions.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.VOLUNTARY_DISCONNECT_ROLE());
    });

    it("voluntarily disconnects the staking vault", async () => {
      await permissions.connect(owner).grantRole(await permissions.VOLUNTARY_DISCONNECT_ROLE(), owner);
      await expect(permissions.connect(owner).voluntaryDisconnect())
        .to.emit(vaultHub, "MockVoluntaryDisconnect")
        .withArgs(permissions, stakingVault);
    });
  });

  context("compensateDisprovenPredeposit", () => {
    it("reverts if the caller does not have the PDG_WITHDRAWAL_ROLE", async () => {
      await expect(permissions.connect(stranger).compensateDisprovenPredepositFromPDG(ethers.randomBytes(32), stranger))
        .to.be.revertedWithCustomError(permissions, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await permissions.PDG_WITHDRAWAL_ROLE());
    });

    it("compensates the disproven predeposit", async () => {
      await permissions.connect(owner).grantRole(await permissions.PDG_WITHDRAWAL_ROLE(), owner);
      const pubkey = ethers.randomBytes(32);
      await expect(permissions.connect(owner).compensateDisprovenPredepositFromPDG(pubkey, owner))
        .to.emit(pdg, "MockCompensateDisprovenPredeposit")
        .withArgs(permissions, pubkey, owner);
    });
  });
});
