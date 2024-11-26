import { expect } from "chai";
import { randomBytes } from "crypto";
import { hexlify, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getStorageAt } from "@nomicfoundation/hardhat-network-helpers";

import { Proxy__Harness, WithdrawalsManagerProxy__Mock } from "typechain-types";

import { ether } from "lib";

import { Snapshot } from "test/suite";

// This is a test suite for a low-level OZ contract located in
// contracts/0.8.4/WithdrawalsManagerProxy.sol:Proxy
// Normally, we do not cover OZ contracts.
// However, this contract code is not included in the source files,
// as opposed to fetching from the OZ repository.
// This means that it is accounted for in test coverage and
// to get 100% coverage, we have to have a test suite for this contract
describe("WithdrawalsManagerProxy.sol:proxy", () => {
  let deployer: HardhatEthersSigner;
  let sender: HardhatEthersSigner;

  let proxy: Proxy__Harness;
  let impl: WithdrawalsManagerProxy__Mock;

  let originalState: string;

  before(async () => {
    [deployer, sender] = await ethers.getSigners();

    impl = await ethers.deployContract("WithdrawalsManagerProxy__Mock", deployer);
    proxy = await ethers.deployContract("Proxy__Harness", deployer);

    proxy = proxy.connect(sender);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("implementation", () => {
    it("Returns implementation", async () => {
      expect(await proxy.implementation()).to.equal(ZeroAddress);

      await proxy.setImplementation(impl);

      expect(await proxy.implementation()).to.equal(impl);
    });
  });

  context("fallback", () => {
    it("Delegates the call to implementation and executes in the context of proxy", async () => {
      const slot = hexlify(randomBytes(32));
      const value = hexlify(randomBytes(32));

      await proxy.setImplementation(impl);

      await sender.sendTransaction({
        to: proxy,
        data: impl.interface.encodeFunctionData("writeToStorage", [slot, value]),
      });

      expect(await getStorageAt(await proxy.getAddress(), slot)).to.equal(value);
    });
  });

  context("receive", () => {
    it("Is called when calldata is empty", async () => {
      await proxy.setImplementation(impl);

      const value = ether("1");

      await expect(
        sender.sendTransaction({
          to: proxy,
          value,
        }),
      ).to.changeEtherBalances([sender, proxy], [-value, value]);
    });
  });
});
