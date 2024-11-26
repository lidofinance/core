import { expect } from "chai";
import { randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { StakingRouter } from "typechain-types";

import { MAX_UINT256, proxify, randomAddress } from "lib";

describe("StakingRouter.sol:Versioned", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let impl: StakingRouter;
  let versioned: StakingRouter;

  const petrifiedVersion = MAX_UINT256;

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    // deploy staking router
    const depositContract = randomAddress();
    const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
    const stakingRouterFactory = await ethers.getContractFactory("StakingRouter", {
      libraries: {
        ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
      },
    });

    impl = await stakingRouterFactory.connect(deployer).deploy(depositContract);

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

      expect(await versioned.getContractVersion()).to.equal(2n);
    });
  });
});
