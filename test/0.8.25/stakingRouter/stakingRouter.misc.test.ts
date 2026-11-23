import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle__MockForStakingRouter, LidoLocator, StakingRouter__Harness } from "typechain-types";

import { certainAddress, ether, MAX_TOP_UP_PER_BLOCK_GWEI, randomWCType1 } from "lib";

import { deployLidoLocator, deployStakingRouter } from "test/deploy";
import { Snapshot } from "test/suite";

describe("StakingRouter.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let stakingRouterAdmin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let locator: LidoLocator;
  let accountingOracle: AccountingOracle__MockForStakingRouter;
  let stakingRouter: StakingRouter__Harness;

  let originalState: string;

  const lido = certainAddress("test:staking-router:lido");
  const topUpGateway = certainAddress("test:staking-router:topUpGateway");
  const depositSecurityModule = certainAddress("test:staking-router:depositSecurityModule");
  const withdrawalCredentials = randomWCType1();

  before(async () => {
    [deployer, admin, stakingRouterAdmin, user] = await ethers.getSigners();

    accountingOracle = await ethers.deployContract("AccountingOracle__MockForStakingRouter", deployer);
    locator = await deployLidoLocator({
      lido,
      topUpGateway,
      depositSecurityModule,
      accountingOracle,
    });

    ({ stakingRouter } = await deployStakingRouter(
      { deployer, admin, user },
      {
        lidoLocator: locator,
      },
    ));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("Reverts if admin is zero address", async () => {
      await expect(
        stakingRouter.initialize(ZeroAddress, withdrawalCredentials, MAX_TOP_UP_PER_BLOCK_GWEI),
      ).to.be.revertedWithCustomError(stakingRouter, "ZeroAddress");
    });

    it("reverts when maxTopUpPerBlockGwei is zero", async () => {
      await expect(
        stakingRouter.initialize(stakingRouterAdmin.address, withdrawalCredentials, 0n),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidMaxTopUpPerBlockGwei");
    });

    it("reverts when maxTopUpPerBlockGwei exceeds uint64", async () => {
      await expect(
        stakingRouter.initialize(stakingRouterAdmin.address, withdrawalCredentials, 2n ** 64n),
      ).to.be.revertedWithCustomError(stakingRouter, "InvalidMaxTopUpPerBlockGwei");
    });

    it("Initializes the contract version, sets up roles and variables", async () => {
      await expect(
        stakingRouter.initialize(stakingRouterAdmin.address, withdrawalCredentials, MAX_TOP_UP_PER_BLOCK_GWEI),
      )
        .to.emit(stakingRouter, "Initialized")
        .withArgs(4)
        .and.to.emit(stakingRouter, "RoleGranted")
        .withArgs(await stakingRouter.DEFAULT_ADMIN_ROLE(), stakingRouterAdmin.address, user.address)
        .and.to.emit(stakingRouter, "WithdrawalCredentialsSet")
        .withArgs(withdrawalCredentials, user.address);

      expect(await stakingRouter.getContractVersion()).to.equal(4);
      expect(await stakingRouter.LIDO_LOCATOR()).to.equal(locator);
      expect(await stakingRouter.getWithdrawalCredentials()).to.equal(withdrawalCredentials);
      expect(await stakingRouter.getMaxTopUpPerBlockGwei()).to.equal(MAX_TOP_UP_PER_BLOCK_GWEI);
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
});
