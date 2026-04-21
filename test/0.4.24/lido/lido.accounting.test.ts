import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForStakingRouter,
  AccountingOracle__MockForStakingRouter__factory,
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
  let accountingOracle: AccountingOracle__MockForStakingRouter;

  beforeEach(async () => {
    [deployer, stranger] = await ethers.getSigners();

    [stakingRouter, withdrawalQueue, burner, elRewardsVault, withdrawalVault, accountingOracle] = await Promise.all([
      new StakingRouter__MockForLidoAccounting__factory(deployer).deploy(),
      new WithdrawalQueue__MockForAccounting__factory(deployer).deploy(),
      new Burner__MockForAccounting__factory(deployer).deploy(),
      new LidoExecutionLayerRewardsVault__MockForLidoAccounting__factory(deployer).deploy(),
      new WithdrawalVault__MockForLidoAccounting__factory(deployer).deploy(),
      new AccountingOracle__MockForStakingRouter__factory(deployer).deploy(),
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
        accountingOracle,
      },
    }));
    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), deployer);

    await acl.createPermission(deployer, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(deployer, lido, await lido.PAUSE_ROLE(), deployer);
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
            clValidatorsBalance: 100n,
            clPendingBalance: 50n,
          }),
        ),
      )
        .to.emit(lido, "CLBalancesUpdated")
        .withArgs(0n, 100n, 50n)
        .and.to.emit(lido, "DepositedPostReportUpdated")
        .withArgs(0n);
    });

    type ArgsTuple = [bigint, bigint, bigint];

    interface Args {
      reportTimestamp: bigint;
      clValidatorsBalance: bigint;
      clPendingBalance: bigint;
    }

    function args(overrides?: Partial<Args>): ArgsTuple {
      return Object.values({
        reportTimestamp: 0n,
        clValidatorsBalance: 0n,
        clPendingBalance: 0n,
        ...overrides,
      }) as ArgsTuple;
    }
  });

  context("collectRewardsAndProcessWithdrawals", async () => {
    async function getAccountingSigner() {
      return impersonate(await locator.accounting(), ether("100.0"));
    }

    async function getStakingRouterSigner() {
      return impersonate(await locator.stakingRouter(), ether("1.0"));
    }

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

      const accountingSigner = await getAccountingSigner();
      lido = lido.connect(accountingSigner);

      await lido.collectRewardsAndProcessWithdrawals(...args({ etherToLockOnWithdrawalQueue: ethToLock }));
      expect(await lido.getBufferedEther()).to.equal(initialBufferedEther - ethToLock);
    });

    it("Withdraws execution layer rewards and adds them to the buffer", async () => {
      const elRewardsToWithdraw = ether("1.0");
      const initialBufferedEther = await lido.getBufferedEther();

      await updateBalance(await elRewardsVault.getAddress(), elRewardsToWithdraw);

      const accountingSigner = await getAccountingSigner();
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

      const accountingSigner = await getAccountingSigner();
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

      const accountingSigner = await getAccountingSigner();
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

      const accountingSigner = await getAccountingSigner();
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

    it("Resyncs deposits reserve to target on report processing when reserve was spent", async () => {
      await acl.createPermission(deployer, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const reserveTarget = ether("3.0");
      await lido.setDepositsReserveTarget(reserveTarget);
      expect(await lido.getDepositsReserve()).to.equal(0n);

      await accountingOracle.mock_setProcessingState(1, true, true);

      const accountingSigner = await getAccountingSigner();
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(...args());

      const bufferedAfterSync = await lido.getBufferedEther();
      const expectedReserveAfterSync = bufferedAfterSync < reserveTarget ? bufferedAfterSync : reserveTarget;

      expect(await lido.getDepositsReserve()).to.equal(expectedReserveAfterSync);
      await lido.submit(await deployer.getAddress(), { value: ether("10.0") });

      const stakingRouterSigner = await getStakingRouterSigner();
      const spendAmount = ether("1.0");
      await lido.connect(stakingRouterSigner).withdrawDepositableEther(spendAmount, 1n);

      expect(await lido.getDepositsReserveTarget()).to.equal(reserveTarget);
      expect(await lido.getDepositsReserve()).to.equal(reserveTarget - spendAmount);

      await expect(lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(...args()))
        .to.emit(lido, "DepositsReserveSet")
        .withArgs(reserveTarget);

      expect(await lido.getDepositsReserve()).to.equal(reserveTarget);
    });

    it("Does not emit DepositsReserveSet on report processing when reserve already matches target", async () => {
      await acl.createPermission(deployer, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const reserveTarget = ether("2.0");
      await lido.setDepositsReserveTarget(reserveTarget);
      expect(await lido.getDepositsReserveTarget()).to.equal(reserveTarget);

      const accountingSigner = await getAccountingSigner();
      // First report syncs reserve to target after target increase.
      await expect(lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(...args()))
        .to.emit(lido, "DepositsReserveSet")
        .withArgs(reserveTarget);

      const bufferedAfterSync = await lido.getBufferedEther();
      const expectedReserveAfterSync = bufferedAfterSync < reserveTarget ? bufferedAfterSync : reserveTarget;
      expect(await lido.getDepositsReserve()).to.equal(expectedReserveAfterSync);

      await expect(lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(...args())).not.to.emit(
        lido,
        "DepositsReserveSet",
      );
    });

    it("Keeps effective deposits reserve capped by buffered ether after report sync", async () => {
      await acl.createPermission(deployer, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const reserveTarget = ether("100.0");
      await lido.setDepositsReserveTarget(reserveTarget);
      expect(await lido.getDepositsReserveTarget()).to.equal(reserveTarget);

      const bufferedBefore = await lido.getBufferedEther();
      expect(bufferedBefore).to.be.gt(0n);

      const reserveBefore = await lido.getDepositsReserve();
      expect(reserveBefore).to.equal(0n);

      // Target increase is deferred until report processing.
      expect(await lido.getDepositsReserve()).to.equal(reserveBefore);

      const submitted = ether("1.0");
      await lido.submit(await deployer.getAddress(), { value: submitted });

      const bufferedAfterSubmit = await lido.getBufferedEther();
      expect(bufferedAfterSubmit).to.equal(bufferedBefore + submitted);
      expect(await lido.getDepositsReserve()).to.equal(reserveBefore);

      const accountingSigner = await getAccountingSigner();
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(...args());

      const bufferedAfter = await lido.getBufferedEther();
      expect(bufferedAfter).to.equal(bufferedAfterSubmit);
      const expectedReserveAfterSync = bufferedAfter < reserveTarget ? bufferedAfter : reserveTarget;
      expect(await lido.getDepositsReserve()).to.equal(expectedReserveAfterSync);
    });

    it("Consumes withdrawals reserve on withdrawal finalization (when deposits reserve = 0)", async () => {
      await acl.createPermission(deployer, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);
      await lido.setDepositsReserveTarget(0n);

      await lido.submit(await deployer.getAddress(), { value: ether("10.0") });

      const unfinalizedBefore = ether("6.0");
      await withdrawalQueue.mock__unfinalizedStETH(unfinalizedBefore);

      const bufferedBefore = await lido.getBufferedEther();
      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getWithdrawalsReserve()).to.equal(unfinalizedBefore);

      const lockAmount = ether("2.0");
      const accountingSigner = await getAccountingSigner();
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(
        ...args({
          lastWithdrawalRequestToFinalize: 1n,
          simulatedShareRate: 1n,
          etherToLockOnWithdrawalQueue: lockAmount,
        }),
      );

      const bufferedAfter = await lido.getBufferedEther();
      expect(bufferedAfter).to.equal(bufferedBefore - lockAmount);
      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getWithdrawalsReserve()).to.equal(unfinalizedBefore - lockAmount);
    });

    it("Consumes withdrawals reserve on withdrawal finalization (when deposits reserve > 0)", async () => {
      await acl.createPermission(deployer, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const reserveTarget = ether("3.0");
      await lido.setDepositsReserveTarget(reserveTarget);

      await lido.submit(await deployer.getAddress(), { value: ether("10.0") });
      await withdrawalQueue.mock__unfinalizedStETH(ether("6.0"));

      const accountingSigner = await getAccountingSigner();
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(...args());

      const depositsReserveBefore = await lido.getDepositsReserve();
      const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
      const bufferedBefore = await lido.getBufferedEther();

      expect(depositsReserveBefore).to.be.gt(0n);
      expect(withdrawalsReserveBefore).to.be.gt(0n);

      const lockAmount = ether("2.0");
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(
        ...args({
          lastWithdrawalRequestToFinalize: 1n,
          simulatedShareRate: 1n,
          etherToLockOnWithdrawalQueue: lockAmount,
        }),
      );

      expect(await lido.getBufferedEther()).to.equal(bufferedBefore - lockAmount);
      expect(await lido.getDepositsReserve()).to.equal(depositsReserveBefore);
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore - lockAmount);
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
