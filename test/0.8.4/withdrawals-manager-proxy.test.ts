import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import {
  WithdrawalsManagerProxy,
  WithdrawalsManagerProxy__factory,
  WithdrawalsManagerStub,
  WithdrawalsManagerStub__factory,
  WithdrawalsVault__MockForWithdrawalManagerProxy,
  WithdrawalsVault__MockForWithdrawalManagerProxy__factory,
} from "typechain-types";

import { certainAddress, streccak } from "lib";

describe("WithdrawalsManagerProxy", () => {
  let deployer: HardhatEthersSigner;
  let voting: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let stub: WithdrawalsManagerStub;
  let proxy: WithdrawalsManagerProxy;
  let newImpl: WithdrawalsVault__MockForWithdrawalManagerProxy;

  beforeEach(async () => {
    [deployer, voting, stranger] = await ethers.getSigners();

    stub = await new WithdrawalsManagerStub__factory(deployer).deploy();
    proxy = await new WithdrawalsManagerProxy__factory(deployer).deploy(voting, stub);

    proxy = proxy.connect(voting);

    newImpl = await new WithdrawalsVault__MockForWithdrawalManagerProxy__factory(deployer).deploy();
  });

  context("implementation", () => {
    it("Returns the addres of the current implementation", async () => {
      expect(await proxy.implementation()).to.equal(stub);
    });
  });

  context("proxy_upgradeTo", () => {
    it("Reverts if ossified", async () => {
      // ossify by setting admin to zero address
      await proxy.proxy_changeAdmin(ZeroAddress);

      await expect(proxy.proxy_upgradeTo(newImpl, "0x")).to.be.rejectedWith("proxy: ossified");
    });

    it("Reverts if the caller is not admin", async () => {
      await expect(proxy.connect(stranger).proxy_upgradeTo(newImpl, "0x")).to.be.rejectedWith("proxy: unauthorized");
    });

    it("Updates implemenation", async () => {
      await expect(proxy.proxy_upgradeTo(newImpl, "0x")).to.emit(proxy, "Upgraded");
      expect(await proxy.implementation()).to.equal(newImpl);
    });

    it("Updates implemenation and executes payload bytecode", async () => {
      const proxyAddr = await proxy.getAddress();
      const storageSlot = streccak("someNumberSlot");
      const someNumber = 1n;

      expect(await getStorageAt(proxyAddr, storageSlot)).to.equal(0n);

      // bytecode to execute in proxy context
      const bytecode = newImpl.interface.encodeFunctionData("mock__changeNumber", [someNumber]);

      await expect(proxy.proxy_upgradeTo(newImpl, bytecode)).to.emit(proxy, "Upgraded").withArgs(newImpl);
      expect(await proxy.implementation()).to.equal(newImpl);

      expect(await getStorageAt(proxyAddr, storageSlot)).to.equal(someNumber);
    });
  });

  context("proxy_getAdmin", () => {
    it("Returns the address of admin", async () => {
      expect(await proxy.proxy_getAdmin()).to.equal(voting);

      const newAdmin = certainAddress("test:wmp:newAdmin");
      await proxy.proxy_changeAdmin(newAdmin);

      expect(await proxy.proxy_getAdmin()).to.equal(newAdmin);
    });
  });

  context("proxy_changeAdmin", () => {
    it("Reverts if the caller is not admin", async () => {
      await expect(proxy.connect(stranger).proxy_changeAdmin(stranger)).to.be.revertedWith("proxy: unauthorized");
    });

    it("Sets new admin", async () => {
      const newAdmin = certainAddress("test:wmp:newAdmin");
      await expect(proxy.proxy_changeAdmin(newAdmin)).to.emit(proxy, "AdminChanged").withArgs(voting, newAdmin);
      expect(await proxy.proxy_getAdmin()).to.equal(newAdmin);
    });
  });

  context("proxy_getIsOssified", () => {
    it("Returns whether the admin is zero address", async () => {
      expect(await proxy.proxy_getIsOssified()).to.be.false;

      await proxy.proxy_changeAdmin(ZeroAddress);

      expect(await proxy.proxy_getIsOssified()).to.be.true;
    });
  });
});
