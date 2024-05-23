import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  Lido,
  LidoLocator,
  LidoLocator__factory,
  StakingRouter__MockForLidoMisc,
  StakingRouter__MockForLidoMisc__factory,
  WithdrawalQueue__MockForLidoMisc,
  WithdrawalQueue__MockForLidoMisc__factory,
} from "typechain-types";

import { batch, certainAddress, ether, impersonate, ONE_ETHER } from "lib";

import { deployLidoDao } from "test/deploy";

describe("Lido:misc", () => {
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

  const elRewardsVaultBalance = ether("100.0");
  const withdrawalsVaultBalance = ether("100.0");

  beforeEach(async () => {
    [deployer, user, stranger, depositSecurityModule] = await ethers.getSigners();

    withdrawalQueue = await new WithdrawalQueue__MockForLidoMisc__factory(deployer).deploy();
    stakingRouter = await new StakingRouter__MockForLidoMisc__factory(deployer).deploy();

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: {
        withdrawalQueue,
        stakingRouter,
        depositSecurityModule,
      },
    }));

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.PAUSE_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE(), deployer);
    lido = lido.connect(user);

    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), user);

    elRewardsVault = await impersonate(await locator.elRewardsVault(), elRewardsVaultBalance);
    withdrawalsVault = await impersonate(await locator.withdrawalVault(), withdrawalsVaultBalance);
  });

  context("receiveELRewards", () => {
    it("Reverts if the caller is not `ElRewardsVault`", async () => {
      await expect(lido.connect(stranger).receiveELRewards()).to.be.revertedWithoutReason();
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
      await expect(lido.connect(stranger).receiveWithdrawals()).to.be.revertedWithoutReason();
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

  context("unsafeChangeDepositedValidators", () => {
    it("Sets the number of deposited validators", async () => {
      const { depositedValidators } = await lido.getBeaconStat();

      const updatedDepositedValidators = depositedValidators + 50n;

      await expect(lido.unsafeChangeDepositedValidators(updatedDepositedValidators))
        .to.emit(lido, "DepositedValidatorsChanged")
        .withArgs(updatedDepositedValidators);

      expect((await lido.getBeaconStat()).depositedValidators).to.equal(updatedDepositedValidators);
    });

    it("Reverts if the caller is unauthorized", async () => {
      await expect(lido.connect(stranger).unsafeChangeDepositedValidators(100n)).to.be.revertedWith("APP_AUTH_FAILED");
    });
  });

  context("getWithdrawalCredentials", () => {
    it("Returns the 0x01 Lido withdrawal credentials", async () => {
      expect(await lido.getWithdrawalCredentials()).to.equal(await stakingRouter.getWithdrawalCredentials());
    });
  });

  context("getOracle", () => {
    it("Returns the address of the legacy oracle", async () => {
      expect(await lido.getOracle()).to.equal(await locator.legacyOracle());
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
    it("Returns the amount of ether eligible for deposits", async () => {
      await lido.resume();

      const bufferedEtherBefore = await lido.getBufferedEther();

      // top up buffer
      const deposit = ether("10.0");
      await lido.submit(ZeroAddress, { value: deposit });

      expect(await lido.getDepositableEther()).to.equal(bufferedEtherBefore + deposit);
    });

    it("Returns 0 if reserved by the buffered ether is fully reserved for withdrawals", async () => {
      await lido.resume();

      const bufferedEther = await lido.getBufferedEther();

      // reserve all buffered ether for withdrawals
      await withdrawalQueue.mock__unfinalizedStETH(bufferedEther);

      expect(await lido.getDepositableEther()).to.equal(0);
    });

    it("Returns the difference if the buffered ether is partially reserved", async () => {
      await lido.resume();

      const bufferedEther = await lido.getBufferedEther();

      // reserve half of buffered ether for withdrawals
      const reservedForWithdrawals = bufferedEther / 2n;
      await withdrawalQueue.mock__unfinalizedStETH(reservedForWithdrawals);

      expect(await lido.getDepositableEther()).to.equal(bufferedEther - reservedForWithdrawals);
    });
  });

  context("deposit", () => {
    const maxDepositsCount = 100n;
    const stakingModuleId = 1n;
    const depositCalldata = new Uint8Array();

    beforeEach(async () => {
      await lido.resume();
      lido = lido.connect(depositSecurityModule);
    });

    it("Reverts if the caller is not `DepositSecurityModule`", async () => {
      lido = lido.connect(stranger);

      await expect(lido.deposit(maxDepositsCount, stakingModuleId, depositCalldata)).to.be.revertedWith(
        "APP_AUTH_DSM_FAILED",
      );
    });

    it("Reverts if the contract is stopped", async () => {
      await lido.connect(user).stop();

      await expect(lido.deposit(maxDepositsCount, stakingModuleId, depositCalldata)).to.be.revertedWith(
        "CAN_NOT_DEPOSIT",
      );
    });

    it("Emits `Unbuffered` and `DepositedValidatorsChanged` events if there are deposits", async () => {
      const oneDepositWorthOfEther = ether("32.0");
      // top up Lido buffer enough for 1 deposit of 32 ether
      await lido.submit(ZeroAddress, { value: oneDepositWorthOfEther });

      expect(await lido.getDepositableEther()).to.be.greaterThanOrEqual(oneDepositWorthOfEther);

      // mock StakingRouter.getStakingModuleMaxDepositsCount returning 1 deposit
      await stakingRouter.mock__getStakingModuleMaxDepositsCount(1);

      const beforeDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      await expect(lido.deposit(maxDepositsCount, stakingModuleId, depositCalldata))
        .to.emit(lido, "Unbuffered")
        .withArgs(oneDepositWorthOfEther)
        .and.to.emit(lido, "DepositedValidatorsChanged")
        .withArgs(beforeDeposit.beaconStat.depositedValidators + 1n)
        .and.to.emit(stakingRouter, "Mock__DepositCalled");

      const afterDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      expect(afterDeposit.beaconStat.depositedValidators).to.equal(beforeDeposit.beaconStat.depositedValidators + 1n);
      expect(afterDeposit.lidoBalance).to.equal(beforeDeposit.lidoBalance - oneDepositWorthOfEther);
      expect(afterDeposit.stakingRouterBalance).to.equal(beforeDeposit.stakingRouterBalance + oneDepositWorthOfEther);
    });

    it("Does not emit `Unbuffered` and `DepositedValidatorsChanged` events if the staking module cannot accomodate new deposit", async () => {
      const oneDepositWorthOfEther = ether("32.0");
      // top up Lido buffer enough for 1 deposit of 32 ether
      await lido.submit(ZeroAddress, { value: oneDepositWorthOfEther });

      expect(await lido.getDepositableEther()).to.be.greaterThanOrEqual(oneDepositWorthOfEther);

      // mock StakingRouter.getStakingModuleMaxDepositsCount returning 1 deposit
      await stakingRouter.mock__getStakingModuleMaxDepositsCount(0);

      const beforeDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      await expect(lido.deposit(maxDepositsCount, stakingModuleId, depositCalldata))
        .to.emit(stakingRouter, "Mock__DepositCalled")
        .not.to.emit(lido, "Unbuffered")
        .and.not.to.emit(lido, "DepositedValidatorsChanged");

      const afterDeposit = await batch({
        lidoBalance: ethers.provider.getBalance(lido),
        stakingRouterBalance: ethers.provider.getBalance(stakingRouter),
        beaconStat: lido.getBeaconStat(),
      });

      expect(afterDeposit.beaconStat.depositedValidators).to.equal(beforeDeposit.beaconStat.depositedValidators);
      expect(afterDeposit.lidoBalance).to.equal(beforeDeposit.lidoBalance);
      expect(afterDeposit.stakingRouterBalance).to.equal(beforeDeposit.stakingRouterBalance);
    });
  });
});
