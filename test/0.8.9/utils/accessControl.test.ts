import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccessControl__Harness } from "typechain-types";

import {
  DEFAULT_ADMIN_ROLE,
  ERC165_INTERFACE_ID,
  INVALID_INTERFACE_ID,
  OZ_ACCESS_CONTROL_INTERFACE_ID,
  streccak,
} from "lib";

import { Snapshot } from "test/suite";

const TEST_ROLE = streccak("TEST_ROLE");
const TEST_ADMIN_ROLE = streccak("TEST_ADMIN_ROLE");

describe("AccessControl", () => {
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let contract: AccessControl__Harness;

  let originalState: string;

  before(async () => {
    [owner, stranger] = await ethers.getSigners();

    contract = await ethers.deployContract("AccessControl__Harness");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("Returns the DEFAULT_ADMIN_ROLE variable", async () => {
      expect(await contract.DEFAULT_ADMIN_ROLE()).to.equal(DEFAULT_ADMIN_ROLE);
    });
  });

  context("Modifiers", () => {
    context("onlyRole", () => {
      it("Reverts if caller does not have the role", async () => {
        await expect(
          contract.connect(stranger).modifierOnlyRole(DEFAULT_ADMIN_ROLE),
        ).to.be.revertedWithOZAccessControlError(stranger.address, DEFAULT_ADMIN_ROLE);
      });

      it("Does not revert if caller has the role", async () => {
        await expect(contract.connect(owner).modifierOnlyRole(DEFAULT_ADMIN_ROLE)).to.not.be.reverted;
      });
    });
  });

  context("supportsInterface", () => {
    it("Returns true for ERC165_INTERFACE_ID", async () => {
      expect(await contract.supportsInterface(ERC165_INTERFACE_ID)).to.be.true;
    });

    it("Returns true for AccessControl", async () => {
      expect(await contract.supportsInterface(OZ_ACCESS_CONTROL_INTERFACE_ID)).to.be.true;
    });

    it("Returns false for invalid interface", async () => {
      expect(await contract.supportsInterface(INVALID_INTERFACE_ID)).to.equal(false);
    });
  });

  context("hasRole", () => {
    it("Returns false for a role that has not been granted", async () => {
      expect(await contract.hasRole(TEST_ROLE, stranger.address)).to.be.false;
    });

    it("Returns true for a role that has been granted", async () => {
      await expect(contract.grantRole(TEST_ROLE, stranger)).to.emit(contract, "RoleGranted");

      expect(await contract.hasRole(TEST_ROLE, stranger.address)).to.be.true;
    });
  });

  context("getRoleAdmin", () => {
    it("Returns the admin role as admin role for itself", async () => {
      expect(await contract.getRoleAdmin(TEST_ROLE)).to.equal(DEFAULT_ADMIN_ROLE);
    });
  });

  context("grantRole", () => {
    it("Reverts if caller is not admin", async () => {
      await expect(
        contract.connect(stranger).grantRole(DEFAULT_ADMIN_ROLE, stranger),
      ).to.be.revertedWithOZAccessControlError(stranger.address, DEFAULT_ADMIN_ROLE);
    });

    it("Does nothing if role is already granted", async () => {
      await expect(contract.grantRole(DEFAULT_ADMIN_ROLE, owner)).not.to.emit(contract, "RoleGranted");
    });

    it("Grants the role", async () => {
      await expect(await contract.grantRole(TEST_ROLE, stranger))
        .to.emit(contract, "RoleGranted")
        .withArgs(TEST_ROLE, stranger.address, owner.address);
    });
  });

  context("revokeRole", () => {
    it("Reverts if caller is not admin", async () => {
      await expect(contract.connect(stranger).revokeRole(TEST_ROLE, stranger)).to.be.revertedWithOZAccessControlError(
        stranger.address,
        DEFAULT_ADMIN_ROLE,
      );
    });

    it("Does nothing if role is already revoked", async () => {
      await expect(contract.revokeRole(TEST_ROLE, stranger)).not.to.emit(contract, "RoleRevoked");
    });

    it("Revokes the role", async () => {
      await contract.grantRole(TEST_ROLE, stranger);

      await expect(await contract.revokeRole(TEST_ROLE, stranger))
        .to.emit(contract, "RoleRevoked")
        .withArgs(TEST_ROLE, stranger.address, owner.address);
    });
  });

  context("renounceRole", () => {
    it("Does nothing if role is already revoked", async () => {
      await expect(contract.connect(stranger).renounceRole(TEST_ROLE, stranger)).not.to.emit(contract, "RoleRevoked");
    });

    it("Reverts if renounce not for self", async () => {
      await expect(contract.renounceRole(TEST_ROLE, stranger)).to.be.revertedWith(
        "AccessControl: can only renounce roles for self",
      );
    });

    it("Revokes the role", async () => {
      await contract.grantRole(TEST_ROLE, stranger);

      await expect(await contract.connect(stranger).renounceRole(TEST_ROLE, stranger))
        .to.emit(contract, "RoleRevoked")
        .withArgs(TEST_ROLE, stranger.address, stranger.address);
    });
  });

  context("_setRoleAdmin", () => {
    it("Sets the role's admin role", async () => {
      await expect(await contract.exposedSetupAdminRole(TEST_ROLE, TEST_ADMIN_ROLE))
        .to.emit(contract, "RoleAdminChanged")
        .withArgs(TEST_ROLE, DEFAULT_ADMIN_ROLE, TEST_ADMIN_ROLE);

      expect(await contract.getRoleAdmin(TEST_ROLE)).to.equal(TEST_ADMIN_ROLE);
    });
  });
});
