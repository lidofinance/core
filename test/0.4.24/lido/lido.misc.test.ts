import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting__MockForAccountingOracle,
  ACL,
  Lido,
  LidoLocator,
  StakingRouter__MockForLidoMisc,
  WithdrawalQueue__MockForLidoMisc,
} from "typechain-types";

import { batch, certainAddress, ether, impersonate, ONE_ETHER } from "lib";

import { deployLidoDao } from "test/deploy";

describe("Lido.sol:misc", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let elRewardsVault: HardhatEthersSigner;
  let withdrawalsVault: HardhatEthersSigner;
  let depositSecurityModule: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let locator: LidoLocator;
  let withdrawalQueue: WithdrawalQueue__MockForLidoMisc;
  let stakingRouter: StakingRouter__MockForLidoMisc;
  let accounting: Accounting__MockForAccountingOracle;

  const elRewardsVaultBalance = ether("100.0");
  const withdrawalsVaultBalance = ether("100.0");

  /// @notice structure of the test does not allow Snapshot usage
  beforeEach(async () => {
    [deployer, user, stranger, depositSecurityModule] = await ethers.getSigners();

    withdrawalQueue = await ethers.deployContract("WithdrawalQueue__MockForLidoMisc", deployer);
    stakingRouter = await ethers.deployContract("StakingRouter__MockForLidoMisc", deployer);
    accounting = await ethers.deployContract("Accounting__MockForAccountingOracle", deployer);

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        withdrawalQueue,
        stakingRouter,
        depositSecurityModule,
        accounting,
      },
    }));

    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE(), deployer);
    lido = lido.connect(user);

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), user);

    elRewardsVault = await impersonate(await locator.elRewardsVault(), elRewardsVaultBalance);
    withdrawalsVault = await impersonate(await locator.withdrawalVault(), withdrawalsVaultBalance);
  });

  context("receiveELRewards", () => {
    it("Reverts if the caller is not `ElRewardsVault`", async () => {
      await expect(lido.connect(stranger).receiveELRewards()).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Tops up the total EL rewards collected", async () => {
      const elRewardsToSend = ONE_ETHER;

      const before = await batch({
        totalElRewardsCollected: lido.getTotalELRewardsCollected(),
        lidoBalance: ethers.provider.getBalance(lido),
      });

      await expect(lido.connect(elRewardsVault).receiveELRewards({ value: elRewardsToSend }))
        .to.emit(lido, "ELRewardsReceived")
        .withArgs(elRewardsToSend);

      const after = await batch({
        totalElRewardsCollected: lido.getTotalELRewardsCollected(),
        lidoBalance: ethers.provider.getBalance(lido),
      });

      expect(after.totalElRewardsCollected).to.equal(before.totalElRewardsCollected + elRewardsToSend);
      expect(after.lidoBalance).to.equal(before.lidoBalance + elRewardsToSend);
    });
  });

  context("getTotalELRewardsCollected", () => {
    it("Returns the current total EL rewards collected", async () => {
      const totalElRewardsBefore = await lido.getTotalELRewardsCollected();
      const elRewardsToSend = ONE_ETHER;

      await lido.connect(elRewardsVault).receiveELRewards({ value: elRewardsToSend });

      expect(await lido.getTotalELRewardsCollected()).to.equal(totalElRewardsBefore + elRewardsToSend);
    });
  });

  context("receiveWithdrawals", () => {
    it("Reverts if the caller is not `WithdrawalsVault`", async () => {
      await expect(lido.connect(stranger).receiveWithdrawals()).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Tops up the Lido buffer", async () => {
      const withdrawalsToSend = ONE_ETHER;

      const lidoBalanceBefore = await ethers.provider.getBalance(lido);

      await expect(lido.connect(withdrawalsVault).receiveWithdrawals({ value: withdrawalsToSend }))
        .to.emit(lido, "WithdrawalsReceived")
        .withArgs(withdrawalsToSend);

      expect(await ethers.provider.getBalance(lido)).to.equal(lidoBalanceBefore + withdrawalsToSend);
    });
  });

  context("transferToVault", () => {
    it("Reverts always", async () => {
      await expect(lido.transferToVault(certainAddress("lido:transferToVault"))).to.be.revertedWith("NOT_SUPPORTED");
    });
  });

  context("getBufferedEther", () => {
    it("Returns ether current buffered on the contract", async () => {
      await lido.resume();

      const bufferedEtherBefore = await lido.getBufferedEther();

      const stakeAmount = ether("10.0");
      await lido.submit(ZeroAddress, { value: stakeAmount });

      expect(await lido.getBufferedEther()).to.equal(bufferedEtherBefore + stakeAmount);
    });
  });

  context("getLidoLocator", () => {
    it("Returns the address of `LidoLocator`", async () => {
      expect(await lido.getLidoLocator()).to.equal(await locator.getAddress());
    });
  });

  context("canDeposit", () => {
    it("Returns true if Lido is not stopped and bunkerMode is disabled", async () => {
      await lido.resume();
      await withdrawalQueue.mock__bunkerMode(false);

      expect(await lido.canDeposit()).to.equal(true);
    });

    it("Returns false if Lido is stopped and bunkerMode is disabled", async () => {
      await withdrawalQueue.mock__bunkerMode(false);

      expect(await lido.canDeposit()).to.equal(false);
    });

    it("Returns false if Lido is not stopped and bunkerMode is enabled", async () => {
      await lido.resume();
      await withdrawalQueue.mock__bunkerMode(true);

      expect(await lido.canDeposit()).to.equal(false);
    });

    it("Returns false if Lido is stopped and bunkerMode is disabled", async () => {
      await withdrawalQueue.mock__bunkerMode(true);

      expect(await lido.canDeposit()).to.equal(false);
    });
  });

  context("getWithdrawalCredentials", () => {
    it("Returns the 0x01 Lido withdrawal credentials", async () => {
      expect(await lido.getWithdrawalCredentials()).to.equal(await stakingRouter.getWithdrawalCredentials());
    });
  });

  context("getTreasury", () => {
    it("Returns the address of the Lido treasury", async () => {
      expect(await lido.getTreasury()).to.equal(await locator.treasury());
    });
  });

  context("getFee", () => {
    it("Returns the protocol fee", async () => {
      expect(await lido.getFee()).to.equal(await stakingRouter.getTotalFeeE4Precision());
    });
  });

  context("getFeeDistribution", () => {
    it("Returns the fee distribution between insurance, treasury, and modules", async () => {
      const totalBasisPoints = await stakingRouter.TOTAL_BASIS_POINTS();
      const totalFee = await stakingRouter.getTotalFeeE4Precision();
      let { treasuryFee, modulesFee } = await stakingRouter.getStakingFeeAggregateDistributionE4Precision();

      const insuranceFee = 0n;
      treasuryFee = (treasuryFee * totalBasisPoints) / totalFee;
      modulesFee = (modulesFee * totalBasisPoints) / totalFee;

      expect(await lido.getFeeDistribution()).to.deep.equal([treasuryFee, insuranceFee, modulesFee]);
    });
  });

  context("getDepositableEther", () => {
    it("Returns the amount of ether eligible for deposits (deposits reserve = 0)", async () => {
      await lido.resume();

      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getDepositsReserveTarget()).to.equal(0n);
      const bufferedEtherBefore = await lido.getBufferedEther();

      // top up buffer
      const deposit = ether("10.0");
      await lido.submit(ZeroAddress, { value: deposit });

      expect(await lido.getDepositableEther()).to.equal(bufferedEtherBefore + deposit);
    });

    it("Returns 0 if buffered ether is fully reserved for withdrawals (deposits reserve = 0)", async () => {
      await lido.resume();

      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getDepositsReserveTarget()).to.equal(0n);
      const bufferedEther = await lido.getBufferedEther();

      // reserve all buffered ether for withdrawals
      await withdrawalQueue.mock__unfinalizedStETH(bufferedEther);

      expect(await lido.getDepositableEther()).to.equal(0);
    });

    it("Returns buffered-minus-withdrawals reserve (deposits reserve = 0)", async () => {
      await lido.resume();

      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getDepositsReserveTarget()).to.equal(0n);
      const bufferedEther = await lido.getBufferedEther();

      // reserve half of buffered ether for withdrawals
      const reservedForWithdrawals = bufferedEther / 2n;
      await withdrawalQueue.mock__unfinalizedStETH(reservedForWithdrawals);

      expect(await lido.getDepositableEther()).to.equal(bufferedEther - reservedForWithdrawals);
    });

    it("Spending depositable ether does not affect withdrawals reserve", async () => {
      await lido.resume();
      await acl.createPermission(user, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const accountingSigner = await impersonate(await locator.accounting(), ether("1.0"));
      const stakingRouterSigner = await impersonate(await locator.stakingRouter(), ether("1.0"));

      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("25.0"));
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);

      const unfinalized = ether("50.0");
      await withdrawalQueue.mock__unfinalizedStETH(unfinalized);

      const bufferedBefore = await lido.getBufferedEther();
      const depositsReserveBefore = await lido.getDepositsReserve();
      const expectedWithdrawalsReserveBefore =
        bufferedBefore - depositsReserveBefore < unfinalized ? bufferedBefore - depositsReserveBefore : unfinalized;
      const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
      expect(withdrawalsReserveBefore).to.equal(expectedWithdrawalsReserveBefore);
      expect(withdrawalsReserveBefore).to.be.gt(0n);
      const depositableBefore = await lido.getDepositableEther();
      expect(depositableBefore).to.be.gt(1n);

      await lido.connect(stakingRouterSigner).withdrawDepositableEther(depositableBefore / 2n, 0n);
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);

      const remainingDepositable = await lido.getDepositableEther();
      await lido.connect(stakingRouterSigner).withdrawDepositableEther(remainingDepositable, 0n);

      expect(await lido.getDepositableEther()).to.equal(0n);
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);
    });

    it("Returns deposits reserve when withdrawals demand saturates remaining buffer", async () => {
      await lido.resume();
      await acl.createPermission(user, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const accountingSigner = await impersonate(await locator.accounting(), ether("1.0"));

      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("25.0"));
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);

      const depositsReserve = await lido.getDepositsReserve();
      expect(depositsReserve).to.equal(ether("25.0"));
      expect(await lido.getDepositableEther()).to.be.gt(depositsReserve);

      await withdrawalQueue.mock__unfinalizedStETH(ether("1000.0"));
      expect(await lido.getDepositableEther()).to.equal(depositsReserve);
    });

    it("Keeps depositable unchanged on reserve target increase before report sync", async () => {
      await lido.resume();
      await acl.createPermission(user, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);

      const accountingSigner = await impersonate(await locator.accounting(), ether("1.0"));

      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("10.0"));
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      await withdrawalQueue.mock__unfinalizedStETH(ether("100.0"));

      const depositableBefore = await lido.getDepositableEther();
      const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
      const depositsReserveBefore = await lido.getDepositsReserve();

      await lido.setDepositsReserveTarget(ether("50.0"));

      expect(await lido.getDepositsReserve()).to.equal(depositsReserveBefore);
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);
      expect(await lido.getDepositableEther()).to.equal(depositableBefore);
    });
  });

  context("depositsReserve", () => {
    let stakingRouterSigner: HardhatEthersSigner;
    let accountingSigner: HardhatEthersSigner;

    const syncReserveWithOracleReport = async () => {
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
    };

    const assertDepositsReserveInvariants = async () => {
      const buffered = await lido.getBufferedEther();
      const depositsReserve = await lido.getDepositsReserve();
      const withdrawalsReserve = await lido.getWithdrawalsReserve();
      const depositable = await lido.getDepositableEther();

      expect(depositsReserve).to.be.lte(buffered);
      expect(withdrawalsReserve).to.be.lte(buffered);
      expect(depositable).to.be.lte(buffered);
      expect(depositable).to.equal(buffered - withdrawalsReserve);
      expect(depositsReserve + withdrawalsReserve).to.be.lte(buffered);
    };

    beforeEach(async () => {
      await lido.resume();
      await acl.createPermission(user, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);
      stakingRouterSigner = await impersonate(await locator.stakingRouter(), ether("1.0"));
      accountingSigner = await impersonate(await locator.accounting(), ether("1.0"));
    });

    it("Reverts if caller has no BUFFER_RESERVE_MANAGER_ROLE", async () => {
      await expect(lido.connect(stranger).setDepositsReserveTarget(ether("1.0"))).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("Calculates allocation consistently with withdrawals reserve and target", async () => {
      const deposit = ether("100.0");
      const reserveTarget = ether("30.0");
      await lido.submit(ZeroAddress, { value: deposit });
      await lido.setDepositsReserveTarget(reserveTarget);
      await syncReserveWithOracleReport();

      const buffered = await lido.getBufferedEther();
      const unfinalized = ether("40.0");
      await withdrawalQueue.mock__unfinalizedStETH(unfinalized);

      const expectedDepositsReserve = buffered < reserveTarget ? buffered : reserveTarget;
      const remainingAfterDeposits = buffered - expectedDepositsReserve;
      const expectedWithdrawalsReserve = remainingAfterDeposits < unfinalized ? remainingAfterDeposits : unfinalized;

      expect(await lido.getDepositsReserve()).to.equal(expectedDepositsReserve);
      expect(await lido.getWithdrawalsReserve()).to.equal(expectedWithdrawalsReserve);
      expect(await lido.getDepositableEther()).to.equal(buffered - expectedWithdrawalsReserve);
    });

    it("Does not increase current reserve immediately when target is increased", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("10.0"));
      await syncReserveWithOracleReport();
      expect(await lido.getDepositsReserve()).to.equal(ether("10.0"));

      await lido.setDepositsReserveTarget(ether("60.0"));
      // Reserve increase is deferred until report processing.
      expect(await lido.getDepositsReserve()).to.equal(ether("10.0"));
      await syncReserveWithOracleReport();
      expect(await lido.getDepositsReserve()).to.equal(ether("60.0"));
    });

    it("Keeps depositable unchanged on target increase before report sync", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("10.0"));
      await syncReserveWithOracleReport();
      await withdrawalQueue.mock__unfinalizedStETH(ether("100.0"));

      const depositableBefore = await lido.getDepositableEther();
      const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();

      await lido.setDepositsReserveTarget(ether("50.0"));

      expect(await lido.getDepositableEther()).to.equal(depositableBefore);
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);
    });

    it("Caps current reserve immediately when target is lowered", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("70.0"));
      await syncReserveWithOracleReport();
      expect(await lido.getDepositsReserve()).to.equal(ether("70.0"));

      await lido.setDepositsReserveTarget(ether("20.0"));
      expect(await lido.getDepositsReserve()).to.equal(ether("20.0"));
    });

    it("Decreases depositable immediately on target decrease in saturated withdrawals demand", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("40.0"));
      await syncReserveWithOracleReport();
      await withdrawalQueue.mock__unfinalizedStETH(ether("1000.0"));

      const buffered = await lido.getBufferedEther();
      expect(await lido.getDepositableEther()).to.equal(ether("40.0"));
      expect(await lido.getWithdrawalsReserve()).to.equal(buffered - ether("40.0"));

      await lido.setDepositsReserveTarget(ether("20.0"));

      expect(await lido.getDepositableEther()).to.equal(ether("20.0"));
      expect(await lido.getWithdrawalsReserve()).to.equal(buffered - ether("20.0"));
    });

    it("Updates depositable immediately when unfinalized withdrawals demand changes", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("30.0"));
      await syncReserveWithOracleReport();

      const buffered = await lido.getBufferedEther();
      const depositsReserve = await lido.getDepositsReserve();

      await withdrawalQueue.mock__unfinalizedStETH(ether("10.0"));
      expect(await lido.getDepositableEther()).to.equal(buffered - ether("10.0"));

      await withdrawalQueue.mock__unfinalizedStETH(ether("50.0"));
      expect(await lido.getDepositableEther()).to.equal(buffered - ether("50.0"));

      await withdrawalQueue.mock__unfinalizedStETH(ether("1000.0"));
      expect(await lido.getDepositableEther()).to.equal(depositsReserve);
    });

    it("Keeps depositable at deposits reserve when unfinalized demand reaches allocation boundary", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("25.0"));
      await syncReserveWithOracleReport();

      const buffered = await lido.getBufferedEther();
      const depositsReserve = await lido.getDepositsReserve();
      const boundary = buffered - depositsReserve;

      await withdrawalQueue.mock__unfinalizedStETH(boundary);
      expect(await lido.getWithdrawalsReserve()).to.equal(boundary);
      expect(await lido.getDepositableEther()).to.equal(depositsReserve);

      await withdrawalQueue.mock__unfinalizedStETH(boundary + 1n);
      expect(await lido.getWithdrawalsReserve()).to.equal(boundary);
      expect(await lido.getDepositableEther()).to.equal(depositsReserve);
    });

    it("Handles setting reserve target to zero", async () => {
      const deposit = ether("100.0");
      await lido.submit(ZeroAddress, { value: deposit });
      await lido.setDepositsReserveTarget(ether("40.0"));
      await syncReserveWithOracleReport();
      expect(await lido.getDepositsReserve()).to.equal(ether("40.0"));

      const unfinalized = ether("30.0");
      await withdrawalQueue.mock__unfinalizedStETH(unfinalized);

      await lido.setDepositsReserveTarget(0n);
      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getWithdrawalsReserve()).to.equal(unfinalized);
      const buffered = await lido.getBufferedEther();
      expect(await lido.getDepositableEther()).to.equal(buffered - unfinalized);
    });

    it("Consumes deposits reserve once when CL-depositable ether is spent and reserve target exceeds buffer", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      const bufferedBefore = await lido.getBufferedEther();

      // Keep all buffered ether depositable and make stored reserve larger than the buffer.
      await withdrawalQueue.mock__unfinalizedStETH(0n);
      await lido.setDepositsReserveTarget(bufferedBefore + ether("100.0"));
      await syncReserveWithOracleReport();

      const spentDepositableEther = ether("10.0");
      await lido.connect(stakingRouterSigner).withdrawDepositableEther(spentDepositableEther, 1n);

      const bufferedAfter = await lido.getBufferedEther();
      expect(bufferedAfter).to.equal(bufferedBefore - spentDepositableEther);
      expect(await lido.getDepositsReserve()).to.equal(bufferedAfter);
      expect(await lido.getDepositableEther()).to.equal(bufferedAfter);
    });

    it("Does not decrease withdrawals reserve when all depositable ether is withdrawn", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("30.0"));
      await syncReserveWithOracleReport();
      await withdrawalQueue.mock__unfinalizedStETH(ether("50.0"));

      const bufferedBefore = await lido.getBufferedEther();
      const withdrawalsReserveBefore = await lido.getWithdrawalsReserve();
      const depositableBefore = await lido.getDepositableEther();
      expect(depositableBefore).to.equal(bufferedBefore - withdrawalsReserveBefore);

      await lido.connect(stakingRouterSigner).withdrawDepositableEther(depositableBefore, 0n);

      expect(await lido.getDepositableEther()).to.equal(0n);
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveBefore);
    });

    it("Emits only target event on target increase and emits reserve update on target decrease", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      const increasedTarget = ether("25.0");
      await expect(lido.setDepositsReserveTarget(increasedTarget))
        .to.emit(lido, "DepositsReserveTargetSet")
        .withArgs(increasedTarget)
        .and.not.to.emit(lido, "DepositsReserveSet");

      await syncReserveWithOracleReport();
      expect(await lido.getDepositsReserve()).to.equal(increasedTarget);

      const loweredTarget = ether("10.0");
      await expect(lido.setDepositsReserveTarget(loweredTarget))
        .to.emit(lido, "DepositsReserveTargetSet")
        .withArgs(loweredTarget)
        .and.to.emit(lido, "DepositsReserveSet")
        .withArgs(loweredTarget);
    });

    it("Keeps deposits reserve at zero when buffer is empty and target is positive", async () => {
      await withdrawalQueue.mock__unfinalizedStETH(0n);
      const depositableBefore = await lido.getDepositableEther();
      if (depositableBefore > 0n) {
        await lido.connect(stakingRouterSigner).withdrawDepositableEther(depositableBefore, 0n);
      }

      expect(await lido.getBufferedEther()).to.equal(0n);

      const target = ether("50.0");
      await lido.setDepositsReserveTarget(target);
      expect(await lido.getDepositsReserveTarget()).to.equal(target);
      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getDepositableEther()).to.equal(0n);

      await syncReserveWithOracleReport();
      expect(await lido.getDepositsReserve()).to.equal(0n);
      expect(await lido.getDepositableEther()).to.equal(0n);
    });

    it("Reverts withdraw when requested amount is above depositable with withdrawals reserve present", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("40.0"));
      await syncReserveWithOracleReport();
      await withdrawalQueue.mock__unfinalizedStETH(ether("80.0"));

      const depositable = await lido.getDepositableEther();
      await expect(lido.connect(stakingRouterSigner).withdrawDepositableEther(depositable + 1n, 0n)).to.be.revertedWith(
        "NOT_ENOUGH_ETHER",
      );
    });

    it("Syncs reserve to target after non-zero accounting buffer movements", async () => {
      await lido.connect(elRewardsVault).receiveELRewards({ value: ether("3.0") });
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setDepositsReserveTarget(ether("20.0"));
      await syncReserveWithOracleReport();
      await lido.connect(stakingRouterSigner).withdrawDepositableEther(ether("5.0"), 0n);
      expect(await lido.getDepositsReserve()).to.equal(ether("15.0"));

      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);

      expect(await lido.getDepositsReserveTarget()).to.equal(ether("20.0"));
      expect(await lido.getDepositsReserve()).to.equal(ether("20.0"));
    });

    it("Exhausts CL-depositable ether via multiple withdrawDepositableEther() calls and then reverts", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("20.0"));
      await syncReserveWithOracleReport();
      await withdrawalQueue.mock__unfinalizedStETH(ether("70.0"));

      const chunk = ether("5.0");

      while ((await lido.getDepositableEther()) >= chunk) {
        await lido.connect(stakingRouterSigner).withdrawDepositableEther(chunk, 0n);
        await assertDepositsReserveInvariants();
      }

      const remaining = await lido.getDepositableEther();
      expect(remaining).to.be.lt(chunk);
      await expect(lido.connect(stakingRouterSigner).withdrawDepositableEther(chunk, 0n)).to.be.revertedWith(
        "NOT_ENOUGH_ETHER",
      );
      await assertDepositsReserveInvariants();
    });

    it("Preserves reserve invariants over submit/withdraw/target-update/report sequence", async () => {
      await lido.submit(ZeroAddress, { value: ether("50.0") });
      await lido.setDepositsReserveTarget(ether("15.0"));
      await syncReserveWithOracleReport();
      await withdrawalQueue.mock__unfinalizedStETH(ether("20.0"));
      await assertDepositsReserveInvariants();

      await lido.connect(stakingRouterSigner).withdrawDepositableEther(ether("10.0"), 0n);
      await assertDepositsReserveInvariants();

      await lido.connect(elRewardsVault).receiveELRewards({ value: ether("7.0") });
      await assertDepositsReserveInvariants();

      await lido.setDepositsReserveTarget(ether("30.0"));
      // target increased, reserve increase is deferred until report
      await assertDepositsReserveInvariants();

      await syncReserveWithOracleReport();
      await assertDepositsReserveInvariants();
    });
  });

  context("withdrawalsReserve", () => {
    let stakingRouterSigner: HardhatEthersSigner;
    let accountingSigner: HardhatEthersSigner;

    beforeEach(async () => {
      await lido.resume();
      await acl.createPermission(user, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);
      stakingRouterSigner = await impersonate(await locator.stakingRouter(), ether("1.0"));
      accountingSigner = await impersonate(await locator.accounting(), ether("1.0"));
    });

    it("Returns 0 when unfinalizedStETH is zero", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("30.0"));
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      await withdrawalQueue.mock__unfinalizedStETH(0n);

      expect(await lido.getWithdrawalsReserve()).to.equal(0n);
    });

    it("Is capped by remaining buffer after deposits reserve", async () => {
      const deposit = ether("100.0");
      await lido.submit(ZeroAddress, { value: deposit });
      await lido.setDepositsReserveTarget(ether("40.0"));
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      await withdrawalQueue.mock__unfinalizedStETH(ether("80.0"));

      const buffered = await lido.getBufferedEther();
      const depositsReserve = await lido.getDepositsReserve();
      expect(await lido.getWithdrawalsReserve()).to.equal(buffered - depositsReserve);
    });

    it("Decreases when deposits reserve target increases (priority to deposits reserve)", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      const buffered = await lido.getBufferedEther();
      // Make withdrawals demand effectively unbounded so withdrawalsReserve == buffered - depositsReserve.
      await withdrawalQueue.mock__unfinalizedStETH(buffered);

      const lowTarget = ether("10.0");
      const highTarget = ether("50.0");

      await lido.setDepositsReserveTarget(lowTarget);
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      const withdrawalsReserveWithLowTarget = await lido.getWithdrawalsReserve();
      expect(withdrawalsReserveWithLowTarget).to.equal(buffered - lowTarget);

      await lido.setDepositsReserveTarget(highTarget);
      // target increase is deferred until report, so withdrawals reserve is unchanged before sync
      expect(await lido.getWithdrawalsReserve()).to.equal(withdrawalsReserveWithLowTarget);
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      const withdrawalsReserveWithHighTarget = await lido.getWithdrawalsReserve();
      expect(withdrawalsReserveWithHighTarget).to.equal(buffered - highTarget);
      expect(withdrawalsReserveWithHighTarget).to.be.lt(withdrawalsReserveWithLowTarget);
    });

    it("Does not change on oracle report when no withdrawals are finalized", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("30.0"));
      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);
      await withdrawalQueue.mock__unfinalizedStETH(ether("40.0"));
      const before = await lido.getWithdrawalsReserve();

      await lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);

      expect(await lido.getWithdrawalsReserve()).to.equal(before);
    });

    it("Returns 0 when buffer is empty even if unfinalizedStETH is non-zero", async () => {
      await withdrawalQueue.mock__unfinalizedStETH(0n);
      const depositableBefore = await lido.getDepositableEther();
      if (depositableBefore > 0n) {
        await lido.connect(stakingRouterSigner).withdrawDepositableEther(depositableBefore, 0n);
      }

      expect(await lido.getBufferedEther()).to.equal(0n);

      await withdrawalQueue.mock__unfinalizedStETH(ether("100.0"));
      expect(await lido.getWithdrawalsReserve()).to.equal(0n);
    });
  });

  context("withdrawDepositableEther", () => {
    let stakingRouterSigner: HardhatEthersSigner;

    beforeEach(async () => {
      await lido.resume();
      // Get stakingRouter signer to call withdrawDepositableEther
      const stakingRouterAddress = await locator.stakingRouter();
      stakingRouterSigner = await impersonate(stakingRouterAddress, ether("1.0"));
    });

    it("Reverts if the caller is not `StakingRouter`", async () => {
      const oneDepositWorthOfEther = ether("32.0");
      await lido.submit(ZeroAddress, { value: oneDepositWorthOfEther });

      await expect(lido.connect(stranger).withdrawDepositableEther(oneDepositWorthOfEther, 1n)).to.be.revertedWith(
        "APP_AUTH_FAILED",
      );
    });

    it("Reverts if amount is zero", async () => {
      await expect(lido.connect(stakingRouterSigner).withdrawDepositableEther(0n, 0n)).to.be.revertedWith(
        "ZERO_AMOUNT",
      );
    });

    it("Reverts if not enough depositable ether", async () => {
      const tooMuchEther = ether("1000.0");
      await expect(lido.connect(stakingRouterSigner).withdrawDepositableEther(tooMuchEther, 1n)).to.be.revertedWith(
        "NOT_ENOUGH_ETHER",
      );
    });

    it("Emits `Unbuffered`, `DepositedValidatorsChanged` and `DepositedBalancesUpdated` events when withdrawing ether", async () => {
      const depositAmount = ether("32.0");
      // top up Lido buffer enough for deposit
      await lido.submit(ZeroAddress, { value: depositAmount });

      // Get actual depositable ether which may be less due to withdrawal reservations
      const depositableEther = await lido.getDepositableEther();
      expect(depositableEther).to.be.greaterThan(0n);

      const beforeDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
        balanceStats: lido.getBalanceStats(),
      });

      // Use actual depositable amount
      const amountToWithdraw = depositableEther;
      await expect(lido.connect(stakingRouterSigner).withdrawDepositableEther(amountToWithdraw, 1n))
        .to.emit(lido, "Unbuffered")
        .withArgs(amountToWithdraw)
        .and.to.emit(lido, "DepositedValidatorsChanged")
        .withArgs(beforeDeposit.beaconStat.depositedValidators + 1n)
        .and.to.emit(lido, "DepositedBalancesUpdated")
        .withArgs(beforeDeposit.balanceStats.depositedSinceLastReport + amountToWithdraw);

      const afterDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      expect(afterDeposit.beaconStat.depositedValidators).to.equal(beforeDeposit.beaconStat.depositedValidators + 1n);
      // Verify ETH moved from Lido to StakingRouter
      expect(afterDeposit.lidoBalance).to.be.lessThan(beforeDeposit.lidoBalance);
      expect(afterDeposit.stakingRouterBalance).to.be.greaterThan(beforeDeposit.stakingRouterBalance);
    });

    it("Does not emit `DepositedValidatorsChanged` event when depositsCount is 0 (top-up scenario)", async () => {
      const depositAmount = ether("10.0");
      // top up Lido buffer
      await lido.submit(ZeroAddress, { value: depositAmount });

      // Get actual depositable ether
      const depositableEther = await lido.getDepositableEther();
      expect(depositableEther).to.be.greaterThan(0n);

      const beforeDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      // Use a smaller amount that's definitely available
      const amountToWithdraw = depositableEther < depositAmount ? depositableEther : depositAmount;

      // depositsCount = 0 for top-up scenario (existing validators, not new ones)
      await expect(lido.connect(stakingRouterSigner).withdrawDepositableEther(amountToWithdraw, 0n))
        .to.emit(lido, "Unbuffered")
        .withArgs(amountToWithdraw)
        .and.not.to.emit(lido, "DepositedValidatorsChanged");

      const afterDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      // depositedValidators should not change for top-ups
      expect(afterDeposit.beaconStat.depositedValidators).to.equal(beforeDeposit.beaconStat.depositedValidators);
      // Verify ETH moved from Lido to StakingRouter
      expect(afterDeposit.lidoBalance).to.be.lessThan(beforeDeposit.lidoBalance);
      expect(afterDeposit.stakingRouterBalance).to.be.greaterThan(beforeDeposit.stakingRouterBalance);
    });
  });
});
