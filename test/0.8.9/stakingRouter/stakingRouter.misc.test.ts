import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DepositContract__MockForBeaconChainDepositor, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, proxify, randomString } from "lib";

import { Snapshot } from "test/suite";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let proxyAdmin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let stakingRouter: StakingRouter__Harness;
  let impl: StakingRouter__Harness;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));
  const withdrawalCredentials02 = hexlify(randomBytes(32));

  const SECONDS_PER_SLOT = 12n;
  const GENESIS_TIME = 1606824023;
  const WITHDRAWAL_CREDENTIALS_TYPE_01 = 1n;

  before(async () => {
    [deployer, proxyAdmin, stakingRouterAdmin, user] = await ethers.getSigners();

    depositContract = await ethers.deployContract("DepositContract__MockForBeaconChainDepositor", deployer);

    const beaconChainDepositor = await ethers.deployContract("BeaconChainDepositor", deployer);
    const depositsTempStorage = await ethers.deployContract("DepositsTempStorage", deployer);
    const depositsTracker = await ethers.deployContract("DepositsTracker", deployer);
    const stakingRouterFactory = await ethers.getContractFactory("StakingRouter__Harness", {
      libraries: {
        ["contracts/0.8.9/BeaconChainDepositor.sol:BeaconChainDepositor"]: await beaconChainDepositor.getAddress(),
        ["contracts/common/lib/DepositsTempStorage.sol:DepositsTempStorage"]: await depositsTempStorage.getAddress(),
        ["contracts/common/lib/DepositsTracker.sol:DepositsTracker"]: await depositsTracker.getAddress(),
      },
    });

    impl = await stakingRouterFactory.connect(deployer).deploy(depositContract, SECONDS_PER_SLOT, GENESIS_TIME);

    [stakingRouter] = await proxify({ impl, admin: proxyAdmin, caller: user });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("Reverts if admin is zero address", async () => {
      await expect(
        stakingRouter.initialize(ZeroAddress, lido, withdrawalCredentials, withdrawalCredentials02),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddressAdmin");
    });

    it("Reverts if lido is zero address", async () => {
      await expect(
        stakingRouter.initialize(
          stakingRouterAdmin.address,
          ZeroAddress,
          withdrawalCredentials,
          withdrawalCredentials02,
        ),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddressLido");
    });

    it("Initializes the contract version, sets up roles and variables", async () => {
      // TODO: add version check
      await expect(
        stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials, withdrawalCredentials02),
      )
        // .to.emit(stakingRouter, "ContractVersionSet")
        // .withArgs(3)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(4);
      expect(await stakingRouter.getLido()).to.equal(lido);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);
    });
  });

  context("finalizeUpgrade_v3()", () => {
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    const modulesCount = 3;

    beforeEach(async () => {
      // initialize staking router
      await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials, withdrawalCredentials02);
      // grant roles
      await stakingRouter
        .connect(stakingRouterAdmin)
        .grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), stakingRouterAdmin);

      const stakingModuleConfig = {
        /// @notice Maximum stake share that can be allocated to a module, in BP.
        /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%).
        stakeShareLimit: STAKE_SHARE_LIMIT,
        /// @notice Module's share threshold, upon crossing which, exits of validators from the module will be prioritized, in BP.
        /// @dev Must be less than or equal to TOTAL_BASIS_POINTS (10_000 BP = 100%) and
        ///      greater than or equal to `stakeShareLimit`.
        priorityExitShareThreshold: PRIORITY_EXIT_SHARE_THRESHOLD,
        /// @notice Part of the fee taken from staking rewards that goes to the staking module, in BP.
        /// @dev Together with `treasuryFee`, must not exceed TOTAL_BASIS_POINTS.
        stakingModuleFee: MODULE_FEE,
        /// @notice Part of the fee taken from staking rewards that goes to the treasury, in BP.
        /// @dev Together with `stakingModuleFee`, must not exceed TOTAL_BASIS_POINTS.
        treasuryFee: TREASURY_FEE,
        /// @notice The maximum number of validators that can be deposited in a single block.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        ///      Value must not exceed type(uint64).max.
        maxDepositsPerBlock: MAX_DEPOSITS_PER_BLOCK,
        /// @notice The minimum distance between deposits in blocks.
        /// @dev Must be harmonized with `OracleReportSanityChecker.appearedValidatorsPerDayLimit`.
        ///      Value must be > 0 and ≤ type(uint64).max.
        minDepositBlockDistance: MIN_DEPOSIT_BLOCK_DISTANCE,
        /// @notice The type of withdrawal credentials for creation of validators.
        /// @dev 1 = 0x01 withdrawals, 2 = 0x02 withdrawals.
        withdrawalCredentialsType: WITHDRAWAL_CREDENTIALS_TYPE_01,
      };

      for (let i = 0; i < modulesCount; i++) {
        await stakingRouter
          .connect(stakingRouterAdmin)
          .addStakingModule(
            randomString(8),
            certainAddress(`test:staking-router:staking-module-${i}`),
            stakingModuleConfig,
          );
      }
      expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount);
    });

    it("fails with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(
        impl.migrateUpgrade_v4(lido, withdrawalCredentials, withdrawalCredentials02),
      ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
    });

    // it("fails with UnexpectedContractVersion error when called on implementation", async () => {
    //   await expect(impl.finalizeUpgrade_v3())
    //     .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
    //     .withArgs(MAX_UINT256, 2);
    // });

    // it("fails with UnexpectedContractVersion error when called on deployed from scratch SRv2", async () => {
    //   await expect(stakingRouter.finalizeUpgrade_v3())
    //     .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
    //     .withArgs(3, 2);
    // });

    // do this check via new Initializer from openzeppelin
    context("simulate upgrade from v2", () => {
      beforeEach(async () => {
        // reset contract version
        await stakingRouter.testing_setVersion(3);
      });

      it("sets correct contract version", async () => {
        expect(await stakingRouter.getContractVersion()).to.equal(3);
        await stakingRouter.migrateUpgrade_v4(lido, withdrawalCredentials, withdrawalCredentials02);
        expect(await stakingRouter.getContractVersion()).to.be.equal(4);
      });
    });
  });

  context("receive", () => {
    it("Reverts", async () => {
      await expect(
        user.sendTransaction({
          to: stakingRouter,
          value: ether("1.0"),
        }),
      ).to.be.revertedWithCustomError(stakingRouter, "DirectETHTransfer");
    });
  });

  context("getLido", () => {
    it("Returns zero address before initialization", async () => {
      expect(await stakingRouter.getLido()).to.equal(ZeroAddress);
    });

    it("Returns lido address after initialization", async () => {
      await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials, withdrawalCredentials02);

      expect(await stakingRouter.getLido()).to.equal(lido);
    });
  });
});
