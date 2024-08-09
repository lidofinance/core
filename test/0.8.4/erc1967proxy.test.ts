import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import {
  ERC1967Proxy__Harness,
  ERC1967Proxy__Harness__factory,
  Impl__MockForERC1967Proxy,
  Impl__MockForERC1967Proxy__factory,
} from "typechain-types";

import { certainAddress } from "lib";

describe("ERC1967Proxy", () => {
  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let proxy: ERC1967Proxy__Harness;
  let impl: Impl__MockForERC1967Proxy;

  beforeEach(async () => {
    [deployer, sender] = await ethers.getSigners();

    impl = await new Impl__MockForERC1967Proxy__factory(deployer).deploy();
    proxy = await new ERC1967Proxy__Harness__factory(deployer).deploy(impl, "0x");

    proxy = proxy.connect(sender);
  });

  context("constructor", () => {
    it("Reverts if the implementation is not a contract", async () => {
      await expect(
        new ERC1967Proxy__Harness__factory(deployer).deploy(certainAddress("test:erc1967:non-contract"), "0x"),
      ).to.be.revertedWith("ERC1967Proxy: new implementation is not a contract");
    });

    it("Executes bytecode", async () => {
      const slot = hexlify(randomBytes(32));
      const value = hexlify(randomBytes(32));

      proxy = await new ERC1967Proxy__Harness__factory(deployer).deploy(
        impl,
        impl.interface.encodeFunctionData("writeToStorage", [slot, value]),
      );

      expect(await getStorageAt(await proxy.getAddress(), slot)).to.equal(value);
    });

    it("Set the implementation", async () => {
      proxy = await new ERC1967Proxy__Harness__factory(deployer).deploy(impl, "0x");

      expect(await proxy.implementation()).to.equal(await impl.getAddress());
    });
  });
});
