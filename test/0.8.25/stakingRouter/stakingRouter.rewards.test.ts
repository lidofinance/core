import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, randomWCType1 } from "lib";
import { StakingModuleStatus, WithdrawalCredentialsType } from "lib/constants";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

import { deployStakingRouter } from "../../deploy/stakingRouter";

import { CtxConfig, DEFAULT_CONFIG, setupModule } from "./helpers";

describe("StakingRouter.sol:rewards", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;

  let locator: LidoLocator;
  let stakingRouter: StakingRouter__Harness;

  let originalState: string;

  let ctx: CtxConfig;

  const DEPOSIT_VALUE = ether("32.0");

  const withdrawalCredentials = randomWCType1();
  const lido = certainAddress("test:staking-router-modules:lido"); // mock lido address

  const topUpGateway = certainAddress("test:staking-router:topUpGateway");
  const depositSecurityModule = certainAddress("test:staking-router:depositSecurityModule");

  before(async () => {
    [deployer, admin] = await ethers.getSigners();

    locator = await deployLidoLocator({
      lido,
      topUpGateway,
      depositSecurityModule,
    });

    ({ stakingRouter } = await deployStakingRouter({ deployer, admin }, { lidoLocator: locator }));

    // initialize staking router
    await stakingRouter.initialize(admin, withdrawalCredentials);

    // grant roles

    await Promise.all([stakingRouter.grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), admin)]);

    ctx = {
      deployer,
      admin,
      stakingRouter,
    };
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

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

      const [, id] = await setupModule(ctx, config);

      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
    });

    it("Returns the maximum allocation to a single module based on the value and module capacity for new module", async () => {
      const maxDeposits = 150n;

      const config = {
        ...DEFAULT_CONFIG,
        depositable: 100n,
        withdrawalCredentialsType: WithdrawalCredentialsType.WC0x02,
      };

      const [, id] = await setupModule(ctx, config);

      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
    });

    it("Returns the maximum allocation based on the value and module capacity if one module on pause", async () => {
      const depositableEther = ether("32") * 100n + 10n;

      const config = {
        ...DEFAULT_CONFIG,
        depositable: 150n,
      };

      const [, id] = await setupModule(ctx, config);
      await setupModule(ctx, { ...config, status: StakingModuleStatus.DepositsPaused });

      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id, depositableEther)).to.equal(100n);
    });

    it("Returns even allocation between modules if target shares are equal and capacities allow for that", async () => {
      const maxDeposits = 200n;

      const config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        depositable: 50n,
      };

      const [, id1] = await setupModule(ctx, config);
      const [, id2] = await setupModule(ctx, config);

      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id1, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
      expect(await stakingRouter.getStakingModuleMaxDepositsCount(id2, maxDeposits * DEPOSIT_VALUE)).to.equal(
        config.depositable,
      );
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
      await setupModule(ctx, DEFAULT_CONFIG);

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

      const [module, id] = await setupModule(ctx, config);

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
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 1000n,
      };

      const [module1, id1] = await setupModule(ctx, config);
      const [module2, id2] = await setupModule(ctx, config);

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
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        deposited: 0n,
      };

      const [module1, id1] = await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

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
        status: StakingModuleStatus.Stopped,
      };

      const [module, id] = await setupModule(ctx, config);

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
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 1_00n,
        treasuryFee: 9_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 8_00n,
        treasuryFee: 2_00n,
        deposited: 1000n,
      };

      const [module1, id1] = await setupModule(ctx, module1Config);
      const [module2, id2] = await setupModule(ctx, module2Config);

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
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 4_00n,
        treasuryFee: 6_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 6_00n,
        treasuryFee: 4_00n,
        deposited: 1000n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

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
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 4_00n,
        treasuryFee: 6_00n,
        deposited: 1000n,
      };

      const module2Config = {
        ...DEFAULT_CONFIG,
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 6_00n,
        treasuryFee: 4_00n,
        deposited: 1000n,
      };

      await setupModule(ctx, module1Config);
      await setupModule(ctx, module2Config);

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
        stakeShareLimit: 50_00n,
        priorityExitShareThreshold: 50_00n,
        moduleFee: 5_00n,
        treasuryFee: 5_00n,
        deposited: 1000n,
      };

      await setupModule(ctx, module1Config);

      expect(await stakingRouter.getTotalFeeE4Precision()).to.equal(10_00n);
    });
  });
});
