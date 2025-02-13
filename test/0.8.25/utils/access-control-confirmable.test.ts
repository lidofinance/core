import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccessControlConfirmable__Harness } from "typechain-types";

import { advanceChainTime, days, getNextBlockTimestamp } from "lib";

describe("AccessControlConfirmable.sol", () => {
  let harness: AccessControlConfirmable__Harness;
  let admin: HardhatEthersSigner;
  let role1Member: HardhatEthersSigner;
  let role2Member: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    [admin, stranger, role1Member, role2Member] = await ethers.getSigners();

    harness = await ethers.deployContract("AccessControlConfirmable__Harness", [admin], admin);
    expect(await harness.getConfirmLifetime()).to.equal(await harness.MIN_CONFIRM_LIFETIME());
    expect(await harness.hasRole(await harness.DEFAULT_ADMIN_ROLE(), admin)).to.be.true;
    expect(await harness.getRoleMemberCount(await harness.DEFAULT_ADMIN_ROLE())).to.equal(1);

    await harness.grantRole(await harness.ROLE_1(), role1Member);
    expect(await harness.hasRole(await harness.ROLE_1(), role1Member)).to.be.true;
    expect(await harness.getRoleMemberCount(await harness.ROLE_1())).to.equal(1);

    await harness.grantRole(await harness.ROLE_2(), role2Member);
    expect(await harness.hasRole(await harness.ROLE_2(), role2Member)).to.be.true;
    expect(await harness.getRoleMemberCount(await harness.ROLE_2())).to.equal(1);
  });

  context("constants", () => {
    it("returns the correct constants", async () => {
      expect(await harness.MIN_CONFIRM_LIFETIME()).to.equal(days(1n));
      expect(await harness.MAX_CONFIRM_LIFETIME()).to.equal(days(30n));
    });
  });

  context("getConfirmLifetime()", () => {
    it("returns the minimal lifetime initially", async () => {
      expect(await harness.getConfirmLifetime()).to.equal(await harness.MIN_CONFIRM_LIFETIME());
    });
  });

  context("confirmingRoles()", () => {
    it("should return the correct roles", async () => {
      expect(await harness.confirmingRoles()).to.deep.equal([await harness.ROLE_1(), await harness.ROLE_2()]);
    });
  });

  context("setConfirmLifetime()", () => {
    it("sets the confirm lifetime", async () => {
      const oldLifetime = await harness.getConfirmLifetime();
      const newLifetime = days(14n);
      await expect(harness.setConfirmLifetime(newLifetime))
        .to.emit(harness, "ConfirmLifetimeSet")
        .withArgs(admin, oldLifetime, newLifetime);
      expect(await harness.getConfirmLifetime()).to.equal(newLifetime);
    });

    it("reverts if the new lifetime is out of bounds", async () => {
      await expect(
        harness.setConfirmLifetime((await harness.MIN_CONFIRM_LIFETIME()) - 1n),
      ).to.be.revertedWithCustomError(harness, "ConfirmLifetimeOutOfBounds");

      await expect(
        harness.setConfirmLifetime((await harness.MAX_CONFIRM_LIFETIME()) + 1n),
      ).to.be.revertedWithCustomError(harness, "ConfirmLifetimeOutOfBounds");
    });
  });

  context("setNumber()", () => {
    it("reverts if the sender does not have the role", async () => {
      for (const role of await harness.confirmingRoles()) {
        expect(await harness.hasRole(role, stranger)).to.be.false;
        await expect(harness.connect(stranger).setNumber(1)).to.be.revertedWithCustomError(harness, "SenderNotMember");
      }
    });

    it("sets the number", async () => {
      const oldNumber = await harness.number();
      const newNumber = oldNumber + 1n;
      // nothing happens
      await harness.connect(role1Member).setNumber(newNumber);
      expect(await harness.number()).to.equal(oldNumber);

      // confirm
      await harness.connect(role2Member).setNumber(newNumber);
      expect(await harness.number()).to.equal(newNumber);
    });

    it("doesn't execute if the confirmation has expired", async () => {
      const oldNumber = await harness.number();
      const newNumber = 1;
      const expiryTimestamp = (await getNextBlockTimestamp()) + (await harness.getConfirmLifetime());
      const msgData = harness.interface.encodeFunctionData("setNumber", [newNumber]);

      await expect(harness.connect(role1Member).setNumber(newNumber))
        .to.emit(harness, "RoleMemberConfirmed")
        .withArgs(role1Member, await harness.ROLE_1(), expiryTimestamp, msgData);
      expect(await harness.confirmations(msgData, await harness.ROLE_1())).to.equal(expiryTimestamp);
      // still old number
      expect(await harness.number()).to.equal(oldNumber);

      await advanceChainTime(expiryTimestamp + 1n);

      const newExpiryTimestamp = (await getNextBlockTimestamp()) + (await harness.getConfirmLifetime());
      await expect(harness.connect(role2Member).setNumber(newNumber))
        .to.emit(harness, "RoleMemberConfirmed")
        .withArgs(role2Member, await harness.ROLE_2(), newExpiryTimestamp, msgData);
      expect(await harness.confirmations(msgData, await harness.ROLE_2())).to.equal(newExpiryTimestamp);
      // still old number
      expect(await harness.number()).to.equal(oldNumber);
    });
  });

  context("decrementWithZeroRoles()", () => {
    it("reverts if there are no confirming roles", async () => {
      await expect(harness.connect(stranger).decrementWithZeroRoles()).to.be.revertedWithCustomError(
        harness,
        "ZeroConfirmingRoles",
      );
    });
  });
});
