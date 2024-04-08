import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { MinFirstAllocationStrategy, OssifiableProxy, StakingRouter, StakingRouter__factory } from "typechain-types";

import { MAX_UINT256, randomAddress } from "lib";

describe("StakingRouter:Versioned", () => {
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let allocLib: MinFirstAllocationStrategy;
  let impl: StakingRouter;
  let proxy: OssifiableProxy;
  let versioned: StakingRouter;

  const petrifiedVersion = MAX_UINT256;

  before(async () => {
    [admin, user] = await ethers.getSigners();

    const depositContract = randomAddress();

    allocLib = await ethers.deployContract("MinFirstAllocationStrategy", []);
    impl = await ethers.deployContract("StakingRouter", [depositContract], {
      libraries: { MinFirstAllocationStrategy: await allocLib.getAddress() },
    });

    proxy = await ethers.deployContract("OssifiableProxy", [await impl.getAddress(), admin.address, new Uint8Array()], {
      from: admin,
    });

    versioned = StakingRouter__factory.connect(await proxy.getAddress(), user);
  });

  context("constructor", () => {
    it("Petrifies the implementation", async () => {
      expect(await impl.getContractVersion()).to.equal(petrifiedVersion);
    });
  });

  context("getContractVersion", () => {
    it("Returns 0 as the initial contract version", async () => {
      expect(await versioned.getContractVersion()).to.equal(0n);
    });
  });

  context("initialize", () => {
    it("Increments version", async () => {
      await versioned.initialize(randomAddress(), randomAddress(), randomBytes(32));

      expect(await versioned.getContractVersion()).to.equal(1n);
    });
  });
});
