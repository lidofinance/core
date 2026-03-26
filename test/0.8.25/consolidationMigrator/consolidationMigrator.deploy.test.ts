import { expect } from "chai";
import { ethers } from "hardhat";

import {
  ConsolidationBus__MockForConsolidationMigrator,
  StakingRouter__MockForConsolidationMigrator,
} from "typechain-types";

import { proxify } from "lib/proxy";

describe("ConsolidationMigrator.sol: deployment", () => {
  let stakingRouter: StakingRouter__MockForConsolidationMigrator;
  let consolidationBus: ConsolidationBus__MockForConsolidationMigrator;

  before(async () => {
    stakingRouter = await ethers.deployContract("StakingRouter__MockForConsolidationMigrator");
    consolidationBus = await ethers.deployContract("ConsolidationBus__MockForConsolidationMigrator");
  });

  it("should deploy and initialize successfully with valid parameters", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    const impl = await ethers.deployContract("ConsolidationMigrator", [stakingRouterAddr, consolidationBusAddr, 1, 2]);
    const [migrator] = await proxify({ impl, admin });
    await migrator.initialize(admin.address);

    const adminRole = await migrator.DEFAULT_ADMIN_ROLE();
    expect(await migrator.hasRole(adminRole, admin.address)).to.be.true;
    expect(await migrator.getStakingRouter()).to.equal(stakingRouterAddr);
    expect(await migrator.getConsolidationBus()).to.equal(consolidationBusAddr);
    expect(await migrator.sourceModuleId()).to.equal(1);
    expect(await migrator.targetModuleId()).to.equal(2);
  });

  it("should revert if admin is zero address on initialize", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    const impl = await ethers.deployContract("ConsolidationMigrator", [stakingRouterAddr, consolidationBusAddr, 1, 2]);
    const [migrator] = await proxify({ impl, admin });

    await expect(migrator.initialize(ethers.ZeroAddress)).to.be.revertedWithCustomError(migrator, "AdminCannotBeZero");
  });

  it("should revert if stakingRouter is zero address", async () => {
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(ethers.deployContract("ConsolidationMigrator", [ethers.ZeroAddress, consolidationBusAddr, 1, 2]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("stakingRouter");
  });

  it("should revert if consolidationBus is zero address", async () => {
    const stakingRouterAddr = await stakingRouter.getAddress();

    await expect(ethers.deployContract("ConsolidationMigrator", [stakingRouterAddr, ethers.ZeroAddress, 1, 2]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("consolidationBus");
  });

  it("should revert if sourceModuleId is zero", async () => {
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(ethers.deployContract("ConsolidationMigrator", [stakingRouterAddr, consolidationBusAddr, 0, 2]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("sourceModuleId");
  });

  it("should revert if targetModuleId is zero", async () => {
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(ethers.deployContract("ConsolidationMigrator", [stakingRouterAddr, consolidationBusAddr, 1, 0]))
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("targetModuleId");
  });

  it("should revert on double initialization", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    const impl = await ethers.deployContract("ConsolidationMigrator", [stakingRouterAddr, consolidationBusAddr, 1, 2]);
    const [migrator] = await proxify({ impl, admin });
    await migrator.initialize(admin.address);

    await expect(migrator.initialize(admin.address)).to.be.revertedWithCustomError(migrator, "InvalidInitialization");
  });
});
