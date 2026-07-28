import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify } from "ethers";
import hre from "hardhat";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";
import type { NetworkHelpers } from "@nomicfoundation/hardhat-network-helpers/types";

import type { ERC1967Proxy__Harness, WithdrawalsManagerProxy__Mock } from "typechain-types/index.js";

import { certainAddress } from "lib/address.js";

import { Snapshot } from "test/suite/index.js";

describe("WithdrawalsManagerProxy.sol:erc1967proxy", () => {
  let ethers: HardhatEthers;
  let networkHelpers: NetworkHelpers;

  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let proxy: ERC1967Proxy__Harness;
  let impl: WithdrawalsManagerProxy__Mock;

  let originalState: string;

  before(async () => {
    ({ ethers, networkHelpers } = await hre.network.getOrCreate());

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

      expect(await networkHelpers.getStorageAt(await proxy.getAddress(), slot)).to.equal(value);
    });

    it("Set the implementation", async () => {
      proxy = await ethers.deployContract("ERC1967Proxy__Harness", [impl, "0x"], deployer);

      expect(await proxy.implementation()).to.equal(impl);
    });
  });
});
