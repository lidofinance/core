import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Burner__MockForAccounting,
  Burner__MockForAccounting__factory,
  IPostTokenRebaseReceiver,
  Lido,
  LidoExecutionLayerRewardsVault__MockForLidoAccounting,
  LidoExecutionLayerRewardsVault__MockForLidoAccounting__factory,
  LidoLocator__factory,
  OracleReportSanityChecker__MockForAccounting,
  OracleReportSanityChecker__MockForAccounting__factory,
  PostTokenRebaseReceiver__MockForAccounting__factory,
  StakingRouter__MockForLidoAccounting,
  StakingRouter__MockForLidoAccounting__factory,
  WithdrawalQueue__MockForAccounting,
  WithdrawalQueue__MockForAccounting__factory,
  WithdrawalVault__MockForLidoAccounting,
  WithdrawalVault__MockForLidoAccounting__factory,
} from "typechain-types";

import { ether, impersonate } from "lib";

import { deployLidoDao } from "test/deploy";

describe("Lido:accounting", () => {
  let deployer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let postTokenRebaseReceiver: IPostTokenRebaseReceiver;

  let elRewardsVault: LidoExecutionLayerRewardsVault__MockForLidoAccounting;
  let withdrawalVault: WithdrawalVault__MockForLidoAccounting;
  let stakingRouter: StakingRouter__MockForLidoAccounting;
  let oracleReportSanityChecker: OracleReportSanityChecker__MockForAccounting;
  let withdrawalQueue: WithdrawalQueue__MockForAccounting;
  let burner: Burner__MockForAccounting;

  beforeEach(async () => {
    [deployer, stranger] = await ethers.getSigners();

    [
      elRewardsVault,
      stakingRouter,
      withdrawalVault,
      oracleReportSanityChecker,
      postTokenRebaseReceiver,
      withdrawalQueue,
      burner,
    ] = await Promise.all([
      new LidoExecutionLayerRewardsVault__MockForLidoAccounting__factory(deployer).deploy(),
      new StakingRouter__MockForLidoAccounting__factory(deployer).deploy(),
      new WithdrawalVault__MockForLidoAccounting__factory(deployer).deploy(),
      new OracleReportSanityChecker__MockForAccounting__factory(deployer).deploy(),
      new PostTokenRebaseReceiver__MockForAccounting__factory(deployer).deploy(),
      new WithdrawalQueue__MockForAccounting__factory(deployer).deploy(),
      new Burner__MockForAccounting__factory(deployer).deploy(),
    ]);

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        withdrawalQueue,
        elRewardsVault,
        withdrawalVault,
        stakingRouter,
        oracleReportSanityChecker,
        postTokenRebaseReceiver,
        burner,
      },
    }));

    await acl.createPermission(deployer, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(deployer, lido, await lido.PAUSE_ROLE(), deployer);
    await acl.createPermission(deployer, lido, await lido.UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE(), deployer);
    await lido.resume();
  });

  context("processClStateUpdate", async () => {
    it("Reverts when contract is stopped", async () => {
      await lido.connect(deployer).stop();
      await expect(lido.processClStateUpdate(...args())).to.be.revertedWith("CONTRACT_IS_STOPPED");
    });

    it("Reverts if sender is not `Accounting`", async () => {
      await expect(lido.connect(stranger).processClStateUpdate(...args())).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Updates beacon stats", async () => {
      const locator = LidoLocator__factory.connect(await lido.getLidoLocator(), deployer);
      const accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
      lido = lido.connect(accountingSigner);
      await expect(
        lido.processClStateUpdate(
          ...args({
            postClValidators: 100n,
            postClBalance: 100n,
          }),
        ),
      )
        .to.emit(lido, "CLValidatorsUpdated")
        .withArgs(0n, 0n, 100n);
    });

    type ArgsTuple = [bigint, bigint, bigint, bigint];

    interface Args {
      reportTimestamp: bigint;
      preClValidators: bigint;
      postClValidators: bigint;
      postClBalance: bigint;
    }

    function args(overrides?: Partial<Args>): ArgsTuple {
      return Object.values({
        reportTimestamp: 0n,
        preClValidators: 0n,
        postClValidators: 0n,
        postClBalance: 0n,
        ...overrides,
      }) as ArgsTuple;
    }
  });

  context("collectRewardsAndProcessWithdrawals", async () => {
    it("Reverts when contract is stopped", async () => {
      await lido.connect(deployer).stop();
      await expect(lido.collectRewardsAndProcessWithdrawals(...args())).to.be.revertedWith("CONTRACT_IS_STOPPED");
    });

    it("Reverts if sender is not `Accounting`", async () => {
      await expect(lido.connect(stranger).collectRewardsAndProcessWithdrawals(...args())).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    type ArgsTuple = [bigint, bigint, bigint, bigint, bigint, bigint, bigint, bigint];

    interface Args {
      reportTimestamp: bigint;
      reportClBalance: bigint;
      adjustedPreCLBalance: bigint;
      withdrawalsToWithdraw: bigint;
      elRewardsToWithdraw: bigint;
      lastWithdrawalRequestToFinalize: bigint;
      simulatedShareRate: bigint;
      etherToLockOnWithdrawalQueue: bigint;
    }

    function args(overrides?: Partial<Args>): ArgsTuple {
      return Object.values({
        reportTimestamp: 0n,
        reportClBalance: 0n,
        adjustedPreCLBalance: 0n,
        withdrawalsToWithdraw: 0n,
        elRewardsToWithdraw: 0n,
        lastWithdrawalRequestToFinalize: 0n,
        simulatedShareRate: 0n,
        etherToLockOnWithdrawalQueue: 0n,
        ...overrides,
      }) as ArgsTuple;
    }
  });
});
