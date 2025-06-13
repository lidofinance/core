import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import { ERC1967Proxy__Harness, WithdrawalsManagerProxy__Mock } from "typechain-types";

import { certainAddress } from "lib";

import { Snapshot } from "test/suite";

describe("WithdrawalsManagerProxy.sol:erc1967proxy", () => {
  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let proxy: ERC1967Proxy__Harness;
  let impl: WithdrawalsManagerProxy__Mock;

  let originalState: string;

  before(async () => {
    [deployer, sender] = await ethers.getSigners();

    impl = await ethers.deployContract("WithdrawalsManagerProxy__Mock", deployer);
    proxy = await ethers.deployContract("ERC1967Proxy__Harness", [impl, "0x"], deployer);

    proxy = proxy.connect(sender);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("Reverts if the implementation is not a contract", async () => {
      await expect(
        ethers.deployContract("ERC1967Proxy__Harness", [certainAddress("test:erc1967:non-contract"), "0x"], deployer),
      ).to.be.revertedWith("ERC1967Proxy: new implementation is not a contract");
    });

    it("Executes bytecode", async () => {
      const slot = hexlify(randomBytes(32));
      const value = hexlify(randomBytes(32));

      proxy = await ethers.deployContract(
        "ERC1967Proxy__Harness",
        [impl, impl.interface.encodeFunctionData("writeToStorage", [slot, value])],
        deployer,
      );

      expect(await getStorageAt(await proxy.getAddress(), slot)).to.equal(value);
    });

    it("Set the implementation", async () => {
      proxy = await ethers.deployContract("ERC1967Proxy__Harness", [impl, "0x"], deployer);

      expect(await proxy.implementation()).to.equal(impl);
    });
  });
});
