import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Burner__MockForAccounting,
  Burner__MockForAccounting__factory,
  Lido,
  LidoExecutionLayerRewardsVault__MockForLidoAccounting,
  LidoExecutionLayerRewardsVault__MockForLidoAccounting__factory,
  LidoLocator,
  LidoLocator__factory,
  StakingRouter__MockForLidoAccounting,
  StakingRouter__MockForLidoAccounting__factory,
  WithdrawalQueue__MockForAccounting,
  WithdrawalQueue__MockForAccounting__factory,
  WithdrawalVault__MockForLidoAccounting,
  WithdrawalVault__MockForLidoAccounting__factory,
} from "typechain-types";

import { ether, getNextBlockTimestamp, impersonate, updateBalance } from "lib";

import { deployLidoDao } from "test/deploy";

describe("Lido:accounting", () => {
  let deployer: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let locator: LidoLocator;

  let stakingRouter: StakingRouter__MockForLidoAccounting;
  let withdrawalQueue: WithdrawalQueue__MockForAccounting;
  let burner: Burner__MockForAccounting;
  let elRewardsVault: LidoExecutionLayerRewardsVault__MockForLidoAccounting;
  let withdrawalVault: WithdrawalVault__MockForLidoAccounting;

  beforeEach(async () => {
    [deployer, stranger] = await ethers.getSigners();

    [stakingRouter, withdrawalQueue, burner, elRewardsVault, withdrawalVault] = await Promise.all([
      new StakingRouter__MockForLidoAccounting__factory(deployer).deploy(),
      new WithdrawalQueue__MockForAccounting__factory(deployer).deploy(),
      new Burner__MockForAccounting__factory(deployer).deploy(),
      new LidoExecutionLayerRewardsVault__MockForLidoAccounting__factory(deployer).deploy(),
      new WithdrawalVault__MockForLidoAccounting__factory(deployer).deploy(),
    ]);

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        withdrawalQueue,
        stakingRouter,
        burner,
        elRewardsVault,
        withdrawalVault,
      },
    }));
    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), deployer);

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

    it("Updates buffered ether", async () => {
      const initialBufferedEther = await lido.getBufferedEther();
      const ethToLock = 1n;

      // assert that the buffer has enough eth to lock for withdrawals
      // should have some eth from the initial 0xdead holder
      expect(initialBufferedEther).greaterThanOrEqual(ethToLock);
      await withdrawalQueue.mock__prefinalizeReturn(ethToLock, 0n);

      const accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
      lido = lido.connect(accountingSigner);

      await lido.collectRewardsAndProcessWithdrawals(...args({ etherToLockOnWithdrawalQueue: ethToLock }));
      expect(await lido.getBufferedEther()).to.equal(initialBufferedEther - ethToLock);
    });

    it("Withdraws execution layer rewards and adds them to the buffer", async () => {
      const elRewardsToWithdraw = ether("1.0");
      const initialBufferedEther = await lido.getBufferedEther();

      await updateBalance(await elRewardsVault.getAddress(), elRewardsToWithdraw);

      const accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
      lido = lido.connect(accountingSigner);

      await expect(lido.collectRewardsAndProcessWithdrawals(...args({ elRewardsToWithdraw })))
        .to.emit(lido, "ELRewardsReceived")
        .withArgs(elRewardsToWithdraw)
        .and.to.emit(lido, "ETHDistributed")
        .withArgs(0n, 0n, 0n, 0n, elRewardsToWithdraw, initialBufferedEther + elRewardsToWithdraw);

      expect(await lido.getBufferedEther()).to.equal(initialBufferedEther + elRewardsToWithdraw);
      expect(await ethers.provider.getBalance(await elRewardsVault.getAddress())).to.equal(0n);
    });

    it("Withdraws withdrawals and adds them to the buffer", async () => {
      const withdrawalsToWithdraw = ether("2.0");
      const initialBufferedEther = await lido.getBufferedEther();

      await updateBalance(await withdrawalVault.getAddress(), withdrawalsToWithdraw);

      const accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
      lido = lido.connect(accountingSigner);

      await expect(lido.collectRewardsAndProcessWithdrawals(...args({ withdrawalsToWithdraw })))
        .to.emit(lido, "WithdrawalsReceived")
        .withArgs(withdrawalsToWithdraw)
        .and.to.emit(lido, "ETHDistributed")
        .withArgs(0n, 0n, 0n, withdrawalsToWithdraw, 0n, initialBufferedEther + withdrawalsToWithdraw);

      expect(await lido.getBufferedEther()).to.equal(initialBufferedEther + withdrawalsToWithdraw);
      expect(await ethers.provider.getBalance(await withdrawalVault.getAddress())).to.equal(0n);
    });

    it("Withdraws both EL rewards and withdrawals and adds them to the buffer", async () => {
      const elRewardsToWithdraw = ether("1.0");
      const withdrawalsToWithdraw = ether("2.0");
      const initialBufferedEther = await lido.getBufferedEther();

      await updateBalance(await elRewardsVault.getAddress(), elRewardsToWithdraw);
      await updateBalance(await withdrawalVault.getAddress(), withdrawalsToWithdraw);

      const accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
      lido = lido.connect(accountingSigner);

      await expect(lido.collectRewardsAndProcessWithdrawals(...args({ elRewardsToWithdraw, withdrawalsToWithdraw })))
        .to.emit(lido, "ELRewardsReceived")
        .withArgs(elRewardsToWithdraw)
        .and.to.emit(lido, "WithdrawalsReceived")
        .withArgs(withdrawalsToWithdraw)
        .and.to.emit(lido, "ETHDistributed")
        .withArgs(
          0n,
          0n,
          0n,
          withdrawalsToWithdraw,
          elRewardsToWithdraw,
          initialBufferedEther + withdrawalsToWithdraw + elRewardsToWithdraw,
        );

      expect(await lido.getBufferedEther()).to.equal(
        initialBufferedEther + elRewardsToWithdraw + withdrawalsToWithdraw,
      );
      expect(await ethers.provider.getBalance(await elRewardsVault.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await withdrawalVault.getAddress())).to.equal(0n);
    });

    it("Emits an `ETHDistributed` event", async () => {
      const reportTimestamp = await getNextBlockTimestamp();
      const preCLBalance = 0n;
      const clBalance = 1n;
      const withdrawals = 0n;
      const elRewards = 0n;
      const bufferedEther = await lido.getBufferedEther();

      const totalFee = 1000;
      const precisionPoints = 10n ** 20n;
      await stakingRouter.mock__getStakingRewardsDistribution([], [], [], totalFee, precisionPoints);

      const accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
      lido = lido.connect(accountingSigner);
      await expect(
        lido.collectRewardsAndProcessWithdrawals(
          ...args({
            reportTimestamp,
            reportClBalance: clBalance,
          }),
        ),
      )
        .to.emit(lido, "ETHDistributed")
        .withArgs(reportTimestamp, preCLBalance, clBalance, withdrawals, elRewards, bufferedEther);
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
