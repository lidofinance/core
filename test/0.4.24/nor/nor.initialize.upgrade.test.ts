import { expect } from "chai";
import { encodeBytes32String, MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";

import { ACL, Kernel, Lido, LidoLocator, NodeOperatorsRegistry__Harness } from "typechain-types";

import { RewardDistributionState } from "lib";

import { addAragonApp, deployLidoDao, deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("NodeOperatorsRegistry.sol:initialize-and-upgrade", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let limitsManager: HardhatEthersSigner;
  let nodeOperatorsManager: HardhatEthersSigner;
  let signingKeysManager: HardhatEthersSigner;
  let stakingRouter: HardhatEthersSigner;

  let nor: NodeOperatorsRegistry__Harness;
  let lido: Lido;
  let dao: Kernel;
  let acl: ACL;
  let locator: LidoLocator;
  let impl: NodeOperatorsRegistry__Harness;

  let originalState: string;

  const moduleType = encodeBytes32String("curated-onchain-v1");
  const contractVersionV2 = 2n;

  before(async () => {
    [deployer, user, stakingRouter, nodeOperatorsManager, signingKeysManager, limitsManager] =
      await ethers.getSigners();

    ({ lido, dao, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        stakingRouter,
      },
    }));

    const allocLib = await ethers.deployContract("MinFirstAllocationStrategy", deployer);
    const norHarnessFactory = await ethers.getContractFactory("NodeOperatorsRegistry__Harness", {
      libraries: {
        ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
      },
    });

    impl = await norHarnessFactory.connect(deployer).deploy();

    expect(await impl.getInitializationBlock()).to.equal(MaxUint256);
    const appProxy = await addAragonApp({
      dao,
      name: "node-operators-registry",
      impl,
      rootAccount: deployer,
    });

    nor = await ethers.getContractAt("NodeOperatorsRegistry__Harness", appProxy, deployer);

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);

    await acl.createPermission(stakingRouter, nor, await nor.STAKING_ROUTER_ROLE(), deployer);
    await acl.createPermission(signingKeysManager, nor, await nor.MANAGE_SIGNING_KEYS(), deployer);
    await acl.createPermission(nodeOperatorsManager, nor, await nor.MANAGE_NODE_OPERATOR_ROLE(), deployer);
    await acl.createPermission(limitsManager, nor, await nor.SET_NODE_OPERATOR_LIMIT_ROLE(), deployer);

    // grant role to nor itself cause it uses solidity's call method to itself
    // inside the harness__requestValidatorsKeysForDeposits() method
    await acl.grantPermission(nor, nor, await nor.STAKING_ROUTER_ROLE());

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    beforeEach(async () => {
      locator = await deployLidoLocator({ lido: lido });
    });

    it("Reverts if Locator is zero address", async () => {
      await expect(nor.initialize(ZeroAddress, moduleType, 86400n, 86400n)).to.be.reverted;
    });

    it("Reverts if was initialized with v1", async () => {
      await nor.harness__initialize(1n);

      await expect(nor.initialize(locator, moduleType, 86400n, 86400n)).to.be.revertedWith("INIT_ALREADY_INITIALIZED");
    });

    it("Reverts if already initialized", async () => {
      await nor.initialize(locator, encodeBytes32String("curated-onchain-v1"), 86400n, 86400n);

      await expect(nor.initialize(locator, moduleType, 86400n, 86400n)).to.be.revertedWith("INIT_ALREADY_INITIALIZED");
    });

    it("Makes the contract initialized to v4", async () => {
      const burnerAddress = await locator.burner();
      const latestBlock = BigInt(await time.latestBlock());

      await expect(nor.initialize(locator, moduleType, 86400n, 86400n))
        .to.emit(nor, "ContractVersionSet")
        .withArgs(contractVersionV2)
        .and.to.emit(nor, "LocatorContractSet")
        .withArgs(await locator.getAddress())
        .and.to.emit(nor, "StakingModuleTypeSet")
        .withArgs(moduleType)
        .to.emit(nor, "RewardDistributionStateChanged")
        .withArgs(RewardDistributionState.Distributed);

      expect(await nor.getLocator()).to.equal(await locator.getAddress());
      expect(await nor.getInitializationBlock()).to.equal(latestBlock + 1n);
      expect(await lido.allowance(await nor.getAddress(), burnerAddress)).to.equal(MaxUint256);
      expect(await nor.getContractVersion()).to.equal(4);
      expect(await nor.getType()).to.equal(moduleType);
    });
  });
});
