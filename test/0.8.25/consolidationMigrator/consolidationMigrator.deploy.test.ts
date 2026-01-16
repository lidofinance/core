import { expect } from "chai";
import { ethers } from "hardhat";

import {
  ConsolidationBus__MockForConsolidationMigrator,
  StakingRouter__MockForConsolidationMigrator,
} from "typechain-types";

describe("ConsolidationMigrator.sol: deployment", () => {
  let stakingRouter: StakingRouter__MockForConsolidationMigrator;
  let consolidationBus: ConsolidationBus__MockForConsolidationMigrator;

  before(async () => {
    stakingRouter = await ethers.deployContract("StakingRouter__MockForConsolidationMigrator");
    consolidationBus = await ethers.deployContract("ConsolidationBus__MockForConsolidationMigrator");
  });

  it("should deploy successfully with valid parameters", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    const migrator = await ethers.deployContract("ConsolidationMigrator", [
      admin.address,
      stakingRouterAddr,
      consolidationBusAddr,
      1, // sourceModuleId
      2, // targetModuleId
    ]);

    const adminRole = await migrator.DEFAULT_ADMIN_ROLE();
    expect(await migrator.hasRole(adminRole, admin.address)).to.be.true;
    expect(await migrator.getStakingRouter()).to.equal(stakingRouterAddr);
    expect(await migrator.getConsolidationBus()).to.equal(consolidationBusAddr);
    expect(await migrator.getSourceModuleId()).to.equal(1);
    expect(await migrator.getTargetModuleId()).to.equal(2);
  });

  it("should revert if admin is zero address", async () => {
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(
      ethers.deployContract("ConsolidationMigrator", [
        ethers.ZeroAddress,
        stakingRouterAddr,
        consolidationBusAddr,
        1,
        2,
      ]),
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "AdminCannotBeZero");
  });

  it("should revert if stakingRouter is zero address", async () => {
    const [admin] = await ethers.getSigners();
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(
      ethers.deployContract("ConsolidationMigrator", [admin.address, ethers.ZeroAddress, consolidationBusAddr, 1, 2]),
    )
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("stakingRouter");
  });

  it("should revert if consolidationBus is zero address", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();

    await expect(
      ethers.deployContract("ConsolidationMigrator", [admin.address, stakingRouterAddr, ethers.ZeroAddress, 1, 2]),
    )
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("consolidationBus");
  });

  it("should revert if sourceModuleId is zero", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(
      ethers.deployContract("ConsolidationMigrator", [
        admin.address,
        stakingRouterAddr,
        consolidationBusAddr,
        0, // zero sourceModuleId
        2,
      ]),
    )
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("sourceModuleId");
  });

  it("should revert if targetModuleId is zero", async () => {
    const [admin] = await ethers.getSigners();
    const stakingRouterAddr = await stakingRouter.getAddress();
    const consolidationBusAddr = await consolidationBus.getAddress();

    await expect(
      ethers.deployContract("ConsolidationMigrator", [
        admin.address,
        stakingRouterAddr,
        consolidationBusAddr,
        1,
        0, // zero targetModuleId
      ]),
    )
      .to.be.revertedWithCustomError(await ethers.getContractFactory("ConsolidationMigrator"), "ZeroArgument")
      .withArgs("targetModuleId");
  });
});
