import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { MinFirstAllocationStrategy__factory, StakingRouter, StakingRouter__factory } from "typechain-types";
import { StakingRouterLibraryAddresses } from "typechain-types/factories/contracts/0.8.9/StakingRouter__factory";

import { MAX_UINT256, proxify, randomAddress } from "lib";

describe("StakingRouter:Versioned", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let impl: StakingRouter;
  let versioned: StakingRouter;

  const petrifiedVersion = MAX_UINT256;

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    // deploy staking router
    const depositContract = randomAddress();
    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: StakingRouterLibraryAddresses = {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    };

    impl = await new StakingRouter__factory(allocLibAddr, deployer).deploy(depositContract);
    [versioned] = await proxify({ impl, admin });
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
