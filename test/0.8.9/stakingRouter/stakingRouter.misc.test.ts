import { expect } from "chai";
import { hexlify, randomBytes, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  DepositContract__MockForBeaconChainDepositor,
  DepositContract__MockForBeaconChainDepositor__factory,
  MinFirstAllocationStrategy__factory,
  StakingRouterMock,
  StakingRouterMock__factory,
} from "typechain-types";
import { StakingRouterLibraryAddresses } from "typechain-types/factories/contracts/0.8.9/StakingRouter__factory";

import { certainAddress, ether, MAX_UINT256, proxify, randomString } from "lib";

describe("StakingRouter", () => {
  let deployer: HardhatEthersSigner;
  let proxyAdmin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let depositContract: DepositContract__MockForBeaconChainDepositor;
  let stakingRouter: StakingRouterMock;
  let impl: StakingRouterMock;

  const lido = certainAddress("test:staking-router:lido");
  const withdrawalCredentials = hexlify(randomBytes(32));

  beforeEach(async () => {
    [deployer, proxyAdmin, stakingRouterAdmin, user] = await ethers.getSigners();

    depositContract = await new DepositContract__MockForBeaconChainDepositor__factory(deployer).deploy();

    const allocLib = await new MinFirstAllocationStrategy__factory(deployer).deploy();
    const allocLibAddr: StakingRouterLibraryAddresses = {
      ["contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy"]: await allocLib.getAddress(),
    };

    impl = await new StakingRouterMock__factory(allocLibAddr, deployer).deploy(depositContract);

    [stakingRouter] = await proxify({ impl, admin: proxyAdmin, caller: user });
  });

  context("initialize", () => {
    it("Reverts if admin is zero address", async () => {
      await expect(stakingRouter.initialize(ZeroAddress, lido, withdrawalCredentials)).to.be.revertedWithCustomError(
        stakingRouter,
        "ZeroAddressAdmin",
      );
    });

    it("Reverts if lido is zero address", async () => {
      await expect(
        stakingRouter.initialize(stakingRouterAdmin.address, ZeroAddress, withdrawalCredentials),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddressLido");
    });

    it("Initializes the contract version, sets up roles and variables", async () => {
      await expect(stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials))
        .to.emit(stakingRouter, "ContractVersionSet")
        .withArgs(2)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(2);
      expect(await stakingRouter.getLido()).to.equal(lido);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);
    });
  });

  context("finalizeUpgrade_v2()", () => {
    const STAKE_SHARE_LIMIT = 1_00n;
    const PRIORITY_EXIT_SHARE_THRESHOLD = STAKE_SHARE_LIMIT;
    const MODULE_FEE = 5_00n;
    const TREASURY_FEE = 5_00n;
    const MAX_DEPOSITS_PER_BLOCK = 150n;
    const MIN_DEPOSIT_BLOCK_DISTANCE = 25n;

    const modulesCount = 3;
    const newPriorityExitShareThresholds = [2_01n, 2_02n, 2_03n];
    const newMaxDepositsPerBlock = [201n, 202n, 203n];
    const newMinDepositBlockDistances = [31n, 32n, 33n];

    beforeEach(async () => {
      // initialize staking router
      await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials);
      // grant roles
      await stakingRouter
        .connect(stakingRouterAdmin)
        .grantRole(await stakingRouter.STAKING_MODULE_MANAGE_ROLE(), stakingRouterAdmin);

      for (let i = 0; i < modulesCount; i++) {
        await stakingRouter
          .connect(stakingRouterAdmin)
          .addStakingModule(
            randomString(8),
            certainAddress(`test:staking-router:staking-module-${i}`),
            STAKE_SHARE_LIMIT,
            PRIORITY_EXIT_SHARE_THRESHOLD,
            MODULE_FEE,
            TREASURY_FEE,
            MAX_DEPOSITS_PER_BLOCK,
            MIN_DEPOSIT_BLOCK_DISTANCE,
          );
      }
      expect(await stakingRouter.getStakingModulesCount()).to.equal(modulesCount);
    });

    it("fails with UnexpectedContractVersion error when called on implementation", async () => {
      await expect(impl.finalizeUpgrade_v2([], [], []))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(MAX_UINT256, 1);
    });

    it("fails with UnexpectedContractVersion error when called on deployed from scratch SRv2", async () => {
      await expect(stakingRouter.finalizeUpgrade_v2([], [], []))
        .to.be.revertedWithCustomError(impl, "UnexpectedContractVersion")
        .withArgs(2, 1);
    });

    context("simulate upgrade from v1", () => {
      beforeEach(async () => {
        // reset contract version
        await stakingRouter.testing_setBaseVersion(1);
      });

      it("fails with ArraysLengthMismatch error when _priorityExitShareThresholds input array length mismatch", async () => {
        const wrongPriorityExitShareThresholds = [1n];
        await expect(
          stakingRouter.finalizeUpgrade_v2(
            wrongPriorityExitShareThresholds,
            newMaxDepositsPerBlock,
            newMinDepositBlockDistances,
          ),
        )
          .to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch")
          .withArgs(3, 1);
      });

      it("fails with ArraysLengthMismatch error when _maxDepositsPerBlock input array length mismatch", async () => {
        const wrongMaxDepositsPerBlock = [100n, 101n];
        await expect(
          stakingRouter.finalizeUpgrade_v2(
            newPriorityExitShareThresholds,
            wrongMaxDepositsPerBlock,
            newMinDepositBlockDistances,
          ),
        )
          .to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch")
          .withArgs(3, 2);
      });

      it("fails with ArraysLengthMismatch error when _minDepositBlockDistances input array length mismatch", async () => {
        const wrongMinDepositBlockDistances = [41n, 42n, 43n, 44n];
        await expect(
          stakingRouter.finalizeUpgrade_v2(
            newPriorityExitShareThresholds,
            newMaxDepositsPerBlock,
            wrongMinDepositBlockDistances,
          ),
        )
          .to.be.revertedWithCustomError(stakingRouter, "ArraysLengthMismatch")
          .withArgs(3, 4);
      });

      it("sets correct contract version", async () => {
        expect(await stakingRouter.getContractVersion()).to.equal(1);
        await stakingRouter.finalizeUpgrade_v2(
          newPriorityExitShareThresholds,
          newMaxDepositsPerBlock,
          newMinDepositBlockDistances,
        );
        expect(await stakingRouter.getContractVersion()).to.be.equal(2);

        const modules = await stakingRouter.getStakingModules();
        expect(modules.length).to.be.equal(modulesCount);

        for (let i = 0; i < modulesCount; i++) {
          expect(modules[i].priorityExitShareThreshold).to.be.equal(newPriorityExitShareThresholds[i]);
          expect(modules[i].maxDepositsPerBlock).to.be.equal(newMaxDepositsPerBlock[i]);
          expect(modules[i].minDepositBlockDistance).to.be.equal(newMinDepositBlockDistances[i]);
        }
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
      await stakingRouter.initialize(stakingRouterAdmin.address, lido, withdrawalCredentials);

      expect(await stakingRouter.getLido()).to.equal(lido);
    });
  });
});
