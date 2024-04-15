import { expect } from "chai";
import { hexlify, randomBytes } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconChainDepositor__factory,
  DepositContract__MockForBeaconChainDepositor__factory,
  StakingModule__Mock,
  StakingModule__Mock__factory,
  StakingRouter,
  StakingRouter__factory,
} from "typechain-types";

import { certainAddress, ether, proxify } from "lib";

describe("StakingRouter:deposits", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let stakingRouter: StakingRouter;

  const DEPOSIT_VALUE = ether("32.0");
  const DEFAULT_CONFIG: ModuleConfig = { targetShare: 100_00n, moduleFee: 5_00n, treasuryFee: 5_00n };

  beforeEach(async () => {
    [deployer, admin] = await ethers.getSigners();

    const depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();
    const beaconChainDepositor = await new BeaconChainDepositor__factory(deployer).deploy(depositContract);
    const impl = await new StakingRouter__factory(deployer).deploy(beaconChainDepositor);

    [stakingRouter] = await proxify({ impl, admin });

    // initialize staking router
    await stakingRouter.initialize(
      admin,
      certainAddress("test:staking-router-modules:lido"), // mock lido address
      hexlify(randomBytes(32)), // mock withdrawal credentials
    );

    // grant roles

    await Promise.all([stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin)]);
  });

  context("getStakingModuleMaxDepositsCount", () => {
    it("Reverts if the module does not exist", async () => {
      await expect(stakingRouter.getStakingModuleMaxDepositsCount(1n, 100n)).to.be.revertedWithCustomError(
        stakingRouter,
        "StakingModuleUnregistered",
      );
    });

    it("Returns the maximum allocation to a single module based on the value and module capacity", async () => {
      const maxDeposits = 150n;

      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
      };

      const [, id] = await setupModule(config);

      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
    });

    it("Returns even allocation between modules if target shares are equal and capacities allow for that", async () => {
      const maxDeposits = 200n;

      const config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        depositable: 50n,
      };

      const [, id1] = await setupModule(config);
      const [, id2] = await setupModule(config);

      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id1, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id2, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
    });
  });

  context("getDepositsAllocation", () => {
    it("Returns 0 allocated and empty allocations when there are no modules registered", async () => {
      expect(await stakingRouter.getDepositsAllocation(100n)).to.deep.equal([0, []]);
    });

    it("Returns all allocations to a single module if there is only one", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
      };

      await setupModule(config);

      expect(await stakingRouter.getDepositsAllocation(150n)).to.deep.equal([config.depositable, [config.depositable]]);
    });

    it("Allocates evenly if target shares are equal and capacities allow for that", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        depositable: 50n,
      };

      await setupModule(config);
      await setupModule(config);

      expect(await stakingRouter.getDepositsAllocation(200n)).to.deep.equal([
        config.depositable * 2n,
        [config.depositable, config.depositable],
      ]);
    });

    it("Allocates according to capacities at equal target shares", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        depositable: 100n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        depositable: 50n,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      expect(await stakingRouter.getDepositsAllocation(200n)).to.deep.equal([
        module1Config.depositable + module2Config.depositable,
        [module1Config.depositable, module2Config.depositable],
      ]);
    });

    it("Allocates according to target shares", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 60_00n,
        depositable: 100n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        targetShare: 40_00n,
        depositable: 100n,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      expect(await stakingRouter.getDepositsAllocation(200n)).to.deep.equal([180n, [100n, 80n]]);
    });
  });

  context("getStakingRewardsDistribution", () => {
    it("Returns empty values if there are no modules", async () => {
      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [],
        [],
        [],
        0n,
        await stakingRouter.FEE_PRECISION_POINTS(),
      ]);
    });

    it("Returns empty values if there are modules but no active validators", async () => {
      await setupModule(DEFAULT_CONFIG);

      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [],
        [],
        [],
        0n,
        await stakingRouter.FEE_PRECISION_POINTS(),
      ]);
    });

    it("Distributes all the rewards to the single module according to set fees", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        deposited: 1000n,
      };

      const [module, id] = await setupModule(config);

      const precision = await stakingRouter.FEE_PRECISION_POINTS();
      const basisPoints = await stakingRouter.TOTAL_BASIS_POINTS();
      const totalFee = await stakingRouter.getTotalFeeE4Precision();

      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [await module.getAddress()],
        [id],
        [(config.moduleFee * precision) / basisPoints],
        (totalFee * precision) / basisPoints,
        precision,
      ]);
    });

    it("Distributes rewards evenly between multiple module if fees are the same", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        deposited: 1000n,
      };

      const [module1, id1] = await setupModule(config);
      const [module2, id2] = await setupModule(config);

      const precision = await stakingRouter.FEE_PRECISION_POINTS();
      const basisPoints = await stakingRouter.TOTAL_BASIS_POINTS();
      const totalFee = await stakingRouter.getTotalFeeE4Precision();

      const totalDeposited = config.deposited * 2n;
      const moduleRewards = (config.moduleFee * precision) / basisPoints / (totalDeposited / config.deposited);
      const totalRewards = (totalFee * precision) / basisPoints;

      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [await module1.getAddress(), await module2.getAddress()],
        [id1, id2],
        [moduleRewards, moduleRewards],
        totalRewards,
        precision,
      ]);
    });

    it("Does not distribute rewards to modules with no active validators", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        deposited: 0n,
      };

      const [module1, id1] = await setupModule(module1Config);
      await setupModule(module2Config);

      const precision = await stakingRouter.FEE_PRECISION_POINTS();
      const basisPoints = await stakingRouter.TOTAL_BASIS_POINTS();
      const totalFee = await stakingRouter.getTotalFeeE4Precision();

      const totalDeposited = module1Config.deposited + module2Config.deposited;
      const totalRewards = (totalFee * precision) / basisPoints;

      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [await module1.getAddress()],
        [id1],
        [(module1Config.moduleFee * precision) / basisPoints / (totalDeposited / module1Config.deposited)],
        totalRewards,
        precision,
      ]);
    });

    it("Distributes module rewards to treasury if the module is stopped", async () => {
      const config = {
        ...DEFAULT_CONFIG,
        deposited: 1000n,
        status: Status.Stopped,
      };

      const [module, id] = await setupModule(config);

      const precision = await stakingRouter.FEE_PRECISION_POINTS();
      const basisPoints = await stakingRouter.TOTAL_BASIS_POINTS();
      const totalFee = await stakingRouter.getTotalFeeE4Precision();

      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [await module.getAddress()],
        [id],
        [0n],
        (totalFee * precision) / basisPoints,
        precision,
      ]);
    });

    it("Distributes rewards between multiple module if according to the set fees", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 1_00n,
        treasuryFee: 9_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 8_00n,
        treasuryFee: 2_00n,
        deposited: 1000n,
      };

      const [module1, id1] = await setupModule(module1Config);
      const [module2, id2] = await setupModule(module2Config);

      const precision = await stakingRouter.FEE_PRECISION_POINTS();
      const basisPoints = await stakingRouter.TOTAL_BASIS_POINTS();
      const totalFee = await stakingRouter.getTotalFeeE4Precision();

      const totalDeposited = module1Config.deposited + module2Config.deposited;
      const totalRewards = (totalFee * precision) / basisPoints;

      expect(await stakingRouter.getStakingRewardsDistribution()).to.deep.equal([
        [await module1.getAddress(), await module2.getAddress()],
        [id1, id2],
        [
          (module1Config.moduleFee * precision) / basisPoints / (totalDeposited / module1Config.deposited),
          (module2Config.moduleFee * precision) / basisPoints / (totalDeposited / module2Config.deposited),
        ],
        totalRewards,
        precision,
      ]);
    });
  });

  context("getStakingFeeAggregateDistribution", () => {
    it("Returns empty values if there are no modules", async () => {
      expect(await stakingRouter.getStakingFeeAggregateDistribution()).to.deep.equal([
        0n,
        0n,
        await stakingRouter.FEE_PRECISION_POINTS(),
      ]);
    });

    it("Returns fee aggregates with two modules with different fees", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 4_00n,
        treasuryFee: 6_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 6_00n,
        treasuryFee: 4_00n,
        deposited: 1000n,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      const precision = await stakingRouter.FEE_PRECISION_POINTS();

      expect(await stakingRouter.getStakingFeeAggregateDistribution()).to.deep.equal([
        5000000000000000000n,
        5000000000000000000n,
        precision,
      ]);
    });
  });

  context("getStakingFeeAggregateDistributionE4Precision", () => {
    it("Returns empty values if there are no modules", async () => {
      expect(await stakingRouter.getStakingFeeAggregateDistributionE4Precision()).to.deep.equal([0n, 0n]);
    });

    it("Returns fee aggregates with two modules with different fees", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 4_00n,
        treasuryFee: 6_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 6_00n,
        treasuryFee: 4_00n,
        deposited: 1000n,
      };

      await setupModule(module1Config);
      await setupModule(module2Config);

      expect(await stakingRouter.getStakingFeeAggregateDistributionE4Precision()).to.deep.equal([500n, 500n]);
    });
  });

  context("getTotalFeeE4Precision", () => {
    it("Returns empty value if there are no modules", async () => {
      expect(await stakingRouter.getTotalFeeE4Precision()).to.equal(0n);
    });

    it("Returns total fee value in 1e4 precision", async () => {
      const module1Config = {
        ...DEFAULT_CONFIG,
        targetShare: 50_00n,
        moduleFee: 5_00n,
        treasuryFee: 5_00n,
        deposited: 1000n,
      };

      await setupModule(module1Config);

      expect(await stakingRouter.getTotalFeeE4Precision()).to.equal(10_00n);
    });
  });

  async function setupModule({
    targetShare,
    moduleFee,
    treasuryFee,
    exited = 0n,
    deposited = 0n,
    depositable = 0n,
    status = Status.Active,
  }: ModuleConfig): Promise<[StakingModule__Mock, bigint]> {
    const modulesCount = await stakingRouter.getStakingModulesCount();
    const module = await new StakingModule__Mock__factory(deployer).deploy();

    await stakingRouter
      .connect(admin)
      .addStakingModule(randomBytes(8).toString(), await module.getAddress(), targetShare, moduleFee, treasuryFee);

    const moduleId = modulesCount + 1n;
    expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount + 1n);

    await module.mock__getStakingModuleSummary(exited, deposited, depositable);

    if (status != Status.Active) {
      await stakingRouter.setStakingModuleStatus(moduleId, status);
    }

    return [module, moduleId];
  }
});

enum Status {
  Active,
  DepositsPaused,
  Stopped,
}

interface ModuleConfig {
  targetShare: bigint;
  moduleFee: bigint;
  treasuryFee: bigint;
  exited?: bigint;
  deposited?: bigint;
  depositable?: bigint;
  status?: Status;
}
