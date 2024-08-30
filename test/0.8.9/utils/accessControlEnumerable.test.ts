import { expect } from "chai";
import { ethers } from "hardhat";

import { PANIC_CODES } from "@nomicfoundation/hardhat-chai-matchers/panic";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccessControlEnumerable__Harness } from "typechain-types";

import {
  ERC165_INTERFACE_ID,
  INVALID_INTERFACE_ID,
  OZ_ACCESS_CONTROL_ENUMERABLE_INTERFACE_ID,
  OZ_ACCESS_CONTROL_INTERFACE_ID,
  streccak,
} from "lib";

import { Snapshot } from "test/suite";

const TEST_ROLE = streccak("TEST_ROLE");

describe("AccessControlEnumerable.sol", () => {
  let owner: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let contract: AccessControlEnumerable__Harness;

  let originalState: string;

  before(async () => {
    [owner, stranger] = await ethers.getSigners();

    contract = await ethers.deployContract("AccessControlEnumerable__Harness");
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("supportsInterface", () => {
    it("Returns true for ERC165_INTERFACE_ID", async () => {
      expect(await contract.supportsInterface(ERC165_INTERFACE_ID)).to.be.true;
    });

    it("Returns true for AccessControl", async () => {
      expect(await contract.supportsInterface(OZ_ACCESS_CONTROL_INTERFACE_ID)).to.be.true;
    });

    it("Returns true for AccessControlEnumerable", async () => {
      expect(await contract.supportsInterface(OZ_ACCESS_CONTROL_ENUMERABLE_INTERFACE_ID)).to.be.true;
    });

    it("Returns false for an invalid interface", async () => {
      expect(await contract.supportsInterface(INVALID_INTERFACE_ID)).to.be.false;
    });
  });

  context("getRoleMemberCount", () => {
    it("Returns 0 if role has no members", async () => {
      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(0);
    });

    it("Returns +1 members count on each grant", async () => {
      await contract.grantRole(TEST_ROLE, owner.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(1);

      await contract.grantRole(TEST_ROLE, stranger.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(2);
    });

    it("Returns -1 members count on each revoke", async () => {
      await contract.grantRole(TEST_ROLE, owner.address);
      await contract.grantRole(TEST_ROLE, stranger.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(2);

      await contract.revokeRole(TEST_ROLE, owner.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(1);
    });

    it("Returns same members count if role has already been granted", async () => {
      await contract.grantRole(TEST_ROLE, owner.address);
      await contract.grantRole(TEST_ROLE, stranger.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(2);

      await contract.grantRole(TEST_ROLE, stranger.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(2);
    });

    it("Returns same members count if role has already been revoked", async () => {
      await contract.grantRole(TEST_ROLE, owner.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(1);

      await contract.revokeRole(TEST_ROLE, stranger.address);

      expect(await contract.getRoleMemberCount(TEST_ROLE)).to.equal(1);
    });
  });

  context("getRoleMember", () => {
    it("Reverts if index is out of bounds", async () => {
      await expect(contract.getRoleMember(TEST_ROLE, 0)).to.be.revertedWithPanic(
        PANIC_CODES.ARRAY_ACCESS_OUT_OF_BOUNDS,
      );
    });

    it("Returns the member address at the given index", async () => {
      await contract.grantRole(TEST_ROLE, owner.address);
      await contract.grantRole(TEST_ROLE, stranger.address);

      expect(await contract.getRoleMember(TEST_ROLE, 0)).to.equal(owner.address);
      expect(await contract.getRoleMember(TEST_ROLE, 1)).to.equal(stranger.address);
    });
  });
});
