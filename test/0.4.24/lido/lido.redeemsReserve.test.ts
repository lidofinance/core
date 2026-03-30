import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AccountingOracle__MockForStakingRouter,
  AccountingOracle__MockForStakingRouter__factory,
  ACL,
  Burner__MockForAccounting,
  Burner__MockForAccounting__factory,
  EtherReceiver__MockForLidoRedeems,
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

import { ether, impersonate } from "lib";

import { deployLidoDao } from "test/deploy";

describe("Lido:redeemsReserve", () => {
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

  let accountingSigner: HardhatEthersSigner;

  const processReport = () =>
    lido.connect(accountingSigner).collectRewardsAndProcessWithdrawals(0n, 0n, 0n, 0n, 0n, 0n, 0n, 0n);

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
    await acl.createPermission(deployer, lido, await lido.BUFFER_RESERVE_MANAGER_ROLE(), deployer);
    await lido.resume();

    accountingSigner = await impersonate(await locator.accounting(), ether("100.0"));
  });

  context("setRedeemsReserveTargetRatio", () => {
    it("should revert when caller has no BUFFER_RESERVE_MANAGER_ROLE", async () => {
      await expect(lido.connect(stranger).setRedeemsReserveTargetRatio(100n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("should revert when ratio exceeds TOTAL_BASIS_POINTS", async () => {
      await expect(lido.setRedeemsReserveTargetRatio(10001n)).to.be.revertedWith("INVALID_RATIO");
    });

    it("should set ratio and emit event", async () => {
      await expect(lido.setRedeemsReserveTargetRatio(500n))
        .to.emit(lido, "RedeemsReserveTargetRatioSet")
        .withArgs(500n);

      expect(await lido.getRedeemsReserveTargetRatio()).to.equal(500n);
    });

    it("should allow setting ratio to 0 to disable reserve", async () => {
      await lido.setRedeemsReserveTargetRatio(500n);
      await expect(lido.setRedeemsReserveTargetRatio(0n)).to.emit(lido, "RedeemsReserveTargetRatioSet").withArgs(0n);
    });

    it("should allow setting ratio to TOTAL_BASIS_POINTS", async () => {
      await expect(lido.setRedeemsReserveTargetRatio(10000n))
        .to.emit(lido, "RedeemsReserveTargetRatioSet")
        .withArgs(10000n);
    });

    it("should reduce reserve immediately when new target is lower", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const reserveBefore = await lido.getRedeemsReserve();
      const targetBefore = await lido.getRedeemsReserveTarget();
      expect(reserveBefore).to.equal(targetBefore);

      await lido.setRedeemsReserveTargetRatio(100n);
      const internalEther = await lido.getTotalPooledEther();
      const expectedTargetAfter = (internalEther * 100n) / 10000n;
      expect(await lido.getRedeemsReserveTarget()).to.equal(expectedTargetAfter);
      expect(await lido.getRedeemsReserve()).to.equal(expectedTargetAfter);
    });

    it("should not change reserve when re-setting the same ratio", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const reserveBefore = await lido.getRedeemsReserve();
      const targetBefore = await lido.getRedeemsReserveTarget();

      await lido.setRedeemsReserveTargetRatio(500n);

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getRedeemsReserveTarget()).to.equal(targetBefore);
    });

    it("should materialize reserve only on report, not on ratio set", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      const internalEther = await lido.getTotalPooledEther();
      const expectedTarget = (internalEther * 500n) / 10000n;
      expect(await lido.getRedeemsReserveTarget()).to.equal(expectedTarget);
      expect(await lido.getRedeemsReserve()).to.equal(0n);

      await processReport();
      expect(await lido.getRedeemsReserve()).to.equal(expectedTarget);
      expect(await lido.getRedeemsReserveTarget()).to.equal(expectedTarget);
    });

    it("should defer reserve increase until oracle report", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(100n);
      await processReport();

      const internalEther = await lido.getTotalPooledEther();
      const oldTarget = (internalEther * 100n) / 10000n;
      const reserveBeforeIncrease = await lido.getRedeemsReserve();
      expect(reserveBeforeIncrease).to.equal(oldTarget);

      await lido.setRedeemsReserveTargetRatio(500n);
      const newTarget = (internalEther * 500n) / 10000n;
      expect(await lido.getRedeemsReserveTarget()).to.equal(newTarget);
      expect(await lido.getRedeemsReserve()).to.equal(oldTarget, "reserve deferred until report");

      await processReport();
      expect(await lido.getRedeemsReserve()).to.equal(newTarget);
      expect(await lido.getRedeemsReserveTarget()).to.equal(newTarget);
    });
  });

  context("setRedeemsReserveGrowthShare", () => {
    it("should revert when caller has no BUFFER_RESERVE_MANAGER_ROLE", async () => {
      await expect(lido.connect(stranger).setRedeemsReserveGrowthShare(100n)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("should revert when share exceeds TOTAL_BASIS_POINTS", async () => {
      await expect(lido.setRedeemsReserveGrowthShare(10001n)).to.be.revertedWith("INVALID_SHARE");
    });

    it("should set share and emit event", async () => {
      await expect(lido.setRedeemsReserveGrowthShare(8000n))
        .to.emit(lido, "RedeemsReserveGrowthShareSet")
        .withArgs(8000n);

      expect(await lido.getRedeemsReserveGrowthShare()).to.equal(8000n);
    });

    it("should allow setting share to 0", async () => {
      await lido.setRedeemsReserveGrowthShare(8000n);
      await expect(lido.setRedeemsReserveGrowthShare(0n)).to.emit(lido, "RedeemsReserveGrowthShareSet").withArgs(0n);
      expect(await lido.getRedeemsReserveGrowthShare()).to.equal(0n);
    });

    it("should allow setting share to TOTAL_BASIS_POINTS", async () => {
      await expect(lido.setRedeemsReserveGrowthShare(10000n))
        .to.emit(lido, "RedeemsReserveGrowthShareSet")
        .withArgs(10000n);
      expect(await lido.getRedeemsReserveGrowthShare()).to.equal(10000n);
    });
  });

  context("setStETHRedeemer", () => {
    it("should revert when caller has no BUFFER_RESERVE_MANAGER_ROLE", async () => {
      await expect(lido.connect(stranger).setStETHRedeemer(stranger.address)).to.be.revertedWith("APP_AUTH_FAILED");
    });

    it("should set redeemer and emit event", async () => {
      await expect(lido.setStETHRedeemer(stranger.address))
        .to.emit(lido, "StETHRedeemerSet")
        .withArgs(stranger.address);

      expect(await lido.getStETHRedeemer()).to.equal(stranger.address);
    });

    it("should allow setting to zero address to disable redemption", async () => {
      await lido.setStETHRedeemer(stranger.address);
      await expect(lido.setStETHRedeemer(ZeroAddress)).to.emit(lido, "StETHRedeemerSet").withArgs(ZeroAddress);
    });

    it("should revoke old redeemer and grant new redeemer on replacement", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(500n);

      const oldRedeemer = await ethers.deployContract(
        "EtherReceiver__MockForLidoRedeems",
        [await lido.getAddress()],
        deployer,
      );
      await lido.setStETHRedeemer(await oldRedeemer.getAddress());
      await processReport();

      const reserve = await lido.getRedeemsReserve();
      await lido.transfer(await oldRedeemer.getAddress(), reserve);

      // Old redeemer works
      const sharesOld = await lido.getSharesByPooledEth(ether("1.0"));
      const etherOld = await lido.getPooledEthByShares(sharesOld);
      await oldRedeemer.callRedeemStETH(ether("1.0"));
      expect(await lido.getRedeemsReserve()).to.equal(reserve - etherOld);

      // Replace redeemer
      const newRedeemer = await ethers.deployContract(
        "EtherReceiver__MockForLidoRedeems",
        [await lido.getAddress()],
        deployer,
      );
      await lido.setStETHRedeemer(await newRedeemer.getAddress());

      // Old redeemer reverts — state unchanged
      const reserveBeforeFailedRedeem = await lido.getRedeemsReserve();
      await expect(oldRedeemer.callRedeemStETH(ether("1.0"))).to.be.revertedWith("APP_AUTH_FAILED");
      expect(await lido.getRedeemsReserve()).to.equal(reserveBeforeFailedRedeem);

      // New redeemer works — exact accounting
      const reserveBeforeNewRedeem = await lido.getRedeemsReserve();
      await lido.transfer(await newRedeemer.getAddress(), ether("1.0"));
      await newRedeemer.callRedeemStETH(ether("1.0"));
      expect(await lido.getRedeemsReserve()).to.be.approximately(reserveBeforeNewRedeem - ether("1.0"), 100n);
    });
  });

  context("_getBufferedEtherAllocation with redeemsReserve", () => {
    it("should allocate redeems reserve before deposits reserve", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await lido.setDepositsReserveTarget(ether("10.0"));
      await processReport();

      const redeemsReserve = await lido.getRedeemsReserve();
      const depositsReserve = await lido.getDepositsReserve();
      const withdrawalsReserve = await lido.getWithdrawalsReserve();
      const buffered = await lido.getBufferedEther();
      const depositable = await lido.getDepositableEther();

      expect(redeemsReserve).to.equal(await lido.getRedeemsReserveTarget());
      expect(depositsReserve).to.equal(ether("10.0"));
      expect(withdrawalsReserve).to.equal(0n);
      expect(depositable).to.equal(buffered - redeemsReserve);
      expect(redeemsReserve + depositsReserve + withdrawalsReserve).to.be.lte(buffered);
    });

    it("should prioritize redeems reserve over deposits reserve when buffer is limited", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await lido.setDepositsReserveTarget(ether("5.0"));
      await processReport();

      const redeemsReserve = await lido.getRedeemsReserve();
      expect(redeemsReserve).to.be.gt(0n);

      await lido.setDepositsReserveTarget(ether("1000.0"));
      await processReport();

      const buffered = await lido.getBufferedEther();
      const redeemsAfter = await lido.getRedeemsReserve();
      const depositsAfter = await lido.getDepositsReserve();

      expect(redeemsAfter).to.equal(await lido.getRedeemsReserveTarget());
      expect(await lido.getWithdrawalsReserve()).to.equal(0n);

      const remainingAfterRedeems = buffered - redeemsAfter;
      expect(depositsAfter).to.equal(remainingAfterRedeems < ether("1000.0") ? remainingAfterRedeems : ether("1000.0"));
      expect(redeemsAfter + depositsAfter).to.be.lte(buffered);
    });

    it("should compute withdrawalsReserve as min of remaining buffer and unfinalizedStETH", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await lido.setDepositsReserveTarget(ether("10.0"));
      await processReport();

      const unfinalized = ether("30.0");
      await withdrawalQueue.mock__unfinalizedStETH(unfinalized);

      const buffered = await lido.getBufferedEther();
      const redeems = await lido.getRedeemsReserve();
      const deposits = await lido.getDepositsReserve();
      const remaining = buffered - redeems - deposits;
      const expectedWQ = remaining < unfinalized ? remaining : unfinalized;

      expect(await lido.getWithdrawalsReserve()).to.equal(expectedWQ);
    });

    it("should exclude redeems reserve from depositable ether", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await lido.setDepositsReserveTarget(ether("10.0"));
      await processReport();

      const depositable = await lido.getDepositableEther();
      const redeemsReserve = await lido.getRedeemsReserve();
      const buffered = await lido.getBufferedEther();

      expect(depositable).to.equal(buffered - redeemsReserve - (await lido.getWithdrawalsReserve()));
    });
  });

  context("_updateBufferedEtherAllocation — replenishment scenarios", () => {
    it("should keep reserve at target when all reserves fit without replenishment", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setDepositsReserveTarget(ether("10.0"));
      await lido.setRedeemsReserveTargetRatio(200n);
      await lido.setRedeemsReserveGrowthShare(8000n);

      await processReport();
      const reserveAfter = await lido.getRedeemsReserve();
      const target = await lido.getRedeemsReserveTarget();

      expect(reserveAfter).to.equal(target);

      await processReport();
      expect(await lido.getRedeemsReserve()).to.equal(target);
    });

    it("should not grow reserve from WQ allocation when growthShareBP is 0 and surplus is consumed", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await lido.setRedeemsReserveGrowthShare(0n);
      await processReport();

      const targetBeforeDrain = await lido.getRedeemsReserveTarget();
      expect(await lido.getRedeemsReserve()).to.equal(targetBeforeDrain);

      // Large WQ demand consumes all unreserved buffer — no surplus left for replenishment
      await withdrawalQueue.mock__unfinalizedStETH(ether("1000.0"));

      await lido.setRedeemsReserveTargetRatio(100n);
      await processReport();

      const reserveAfterDecrease = await lido.getRedeemsReserve();
      expect(reserveAfterDecrease).to.equal(await lido.getRedeemsReserveTarget());

      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const reserveAfterReplenish = await lido.getRedeemsReserve();
      expect(reserveAfterReplenish).to.equal(
        reserveAfterDecrease,
        "with shareBP=0 and no surplus, reserve should not grow from WQ allocation",
      );
    });

    it("should cap reserve to new target when ratio decreases below current reserve", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const internalEther = await lido.getTotalPooledEther();
      const expectedTarget500 = (internalEther * 500n) / 10000n;
      expect(await lido.getRedeemsReserve()).to.equal(expectedTarget500);

      await lido.setRedeemsReserveTargetRatio(200n);
      const expectedTarget200 = (internalEther * 200n) / 10000n;
      expect(await lido.getRedeemsReserve()).to.equal(expectedTarget200);
      expect(await lido.getRedeemsReserveTarget()).to.equal(expectedTarget200);

      await processReport();
      expect(await lido.getRedeemsReserve()).to.equal(expectedTarget200);
      expect(await lido.getRedeemsReserveTarget()).to.equal(expectedTarget200);
    });

    it("should emit RedeemsReserveSet when reserve grows on report", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });

      await lido.setRedeemsReserveTargetRatio(100n);
      await lido.setRedeemsReserveGrowthShare(8000n);
      await processReport();

      await lido.setRedeemsReserveTargetRatio(500n);

      const reserveBefore = await lido.getRedeemsReserve();
      const targetBefore = await lido.getRedeemsReserveTarget();
      expect(reserveBefore).to.be.lt(targetBefore);

      await expect(processReport()).to.emit(lido, "RedeemsReserveSet");

      const reserveAfter = await lido.getRedeemsReserve();
      const targetAfter = await lido.getRedeemsReserveTarget();
      expect(targetAfter).to.equal(targetBefore);
      expect(reserveAfter).to.be.gt(reserveBefore);
      expect(reserveAfter).to.equal(targetAfter);
    });

    it("should not emit RedeemsReserveSet when reserve is already at target", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(200n);
      await processReport();

      await expect(processReport()).not.to.emit(lido, "RedeemsReserveSet");
    });
  });

  context("inter-report behavior", () => {
    it("should not replenish reserve when submits occur between reports", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const redeemer = await ethers.deployContract(
        "EtherReceiver__MockForLidoRedeems",
        [await lido.getAddress()],
        deployer,
      );
      const redeemerAddr = await redeemer.getAddress();
      await lido.setStETHRedeemer(redeemerAddr);

      const drainAmount = ether("2.0");
      await lido.transfer(redeemerAddr, drainAmount);
      await redeemer.callRedeemStETH(drainAmount);

      const reserveAfterDrain = await lido.getRedeemsReserve();
      expect(reserveAfterDrain).to.be.lt(await lido.getRedeemsReserveTarget());

      const bufferedBeforeSubmit = await lido.getBufferedEther();
      const internalEtherBeforeSubmit = await lido.getTotalPooledEther();
      await lido.connect(stranger).submit(ZeroAddress, { value: ether("50.0") });
      const internalEtherAfterSubmit = await lido.getTotalPooledEther();
      expect(internalEtherAfterSubmit).to.equal(internalEtherBeforeSubmit + ether("50.0"));
      expect(await lido.getBufferedEther()).to.equal(bufferedBeforeSubmit + ether("50.0"));
      expect(await lido.getRedeemsReserve()).to.equal(reserveAfterDrain);
      expect(await lido.getRedeemsReserveTarget()).to.equal((internalEtherAfterSubmit * 500n) / 10000n);

      await processReport();
      expect(await lido.getRedeemsReserve()).to.equal(await lido.getRedeemsReserveTarget());
    });
  });

  context("negative rebase and post-slashing", () => {
    it("should cap reserve to new lower target after negative rebase", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      // Set initial CL balance so we can lower it later
      await lido.connect(accountingSigner).processClStateUpdate(1n, ether("50"), 0n);
      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const targetBefore = await lido.getRedeemsReserveTarget();
      expect(await lido.getRedeemsReserve()).to.equal(targetBefore);

      // Simulate negative rebase by lowering CL validators balance
      await lido.connect(accountingSigner).processClStateUpdate(2n, ether("10"), 0n);
      await processReport();

      const targetAfter = await lido.getRedeemsReserveTarget();
      expect(targetAfter).to.be.lt(targetBefore, "target should decrease after negative rebase");
      expect(await lido.getRedeemsReserve()).to.equal(targetAfter);
    });

    it("should preserve share rate when redeeming at post-slashing rate", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      // Set initial CL balance so we can slash it
      await lido.connect(accountingSigner).processClStateUpdate(1n, ether("50"), 0n);
      await lido.setRedeemsReserveTargetRatio(500n);
      await processReport();

      const rateBefore = await lido.getPooledEthByShares(ether("1"));

      // Simulate slashing by lowering CL balance
      await lido.connect(accountingSigner).processClStateUpdate(2n, ether("10"), 0n);
      await processReport();

      const rateAfterSlash = await lido.getPooledEthByShares(ether("1"));
      expect(rateAfterSlash).to.be.lt(rateBefore, "rate should drop after slashing");

      const redeemer = await ethers.deployContract(
        "EtherReceiver__MockForLidoRedeems",
        [await lido.getAddress()],
        deployer,
      );
      const redeemerAddr = await redeemer.getAddress();
      await lido.setStETHRedeemer(redeemerAddr);

      const redeemAmount = ether("2.0");
      await lido.transfer(redeemerAddr, redeemAmount);

      const reserveBeforeRedeem = await lido.getRedeemsReserve();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();
      const rateBeforeRedeem = await lido.getPooledEthByShares(ether("1"));

      const sharesAmount = await lido.getSharesByPooledEth(redeemAmount);

      await redeemer.callRedeemStETH(redeemAmount);

      expect(await lido.getRedeemsReserve()).to.be.approximately(reserveBeforeRedeem - redeemAmount, 100n);
      expect(await lido.getTotalPooledEther()).to.be.approximately(totalPooledBefore - redeemAmount, 100n);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore - sharesAmount);

      const rateAfterRedeem = await lido.getPooledEthByShares(ether("1"));
      expect(rateAfterRedeem).to.be.gte(rateBeforeRedeem, "share rate should not decrease after redeem");
      expect(rateAfterRedeem - rateBeforeRedeem).to.be.lte(1n, "share rate drift exceeds tolerance");
    });
  });

  context("staking limit interaction", () => {
    it("should not restore staking limit consumed by submit when redeeming", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(500n);

      await acl.createPermission(deployer, lido, await lido.STAKING_CONTROL_ROLE(), deployer);
      // rate = 0 disables time-based regeneration so limit changes are deterministic
      await lido.setStakingLimit(ether("150"), 0n);
      await processReport();

      const limitAfterReport = await lido.getCurrentStakeLimit();

      await lido.connect(stranger).submit(ZeroAddress, { value: ether("10.0") });
      const limitAfterSubmit = await lido.getCurrentStakeLimit();
      expect(limitAfterSubmit).to.equal(limitAfterReport - ether("10.0"));

      const redeemer = await ethers.deployContract(
        "EtherReceiver__MockForLidoRedeems",
        [await lido.getAddress()],
        deployer,
      );
      const redeemerAddr = await redeemer.getAddress();
      await lido.setStETHRedeemer(redeemerAddr);

      const reserve = await lido.getRedeemsReserve();
      expect(reserve).to.be.gt(0n);
      await lido.transfer(redeemerAddr, reserve);

      await redeemer.callRedeemStETH(reserve);

      expect(await lido.getRedeemsReserve()).to.equal(0n);
      expect(await lido.getCurrentStakeLimit()).to.equal(limitAfterSubmit);
    });
  });

  context("redeemStETH", () => {
    let redeemer: EtherReceiver__MockForLidoRedeems;

    beforeEach(async () => {
      redeemer = await ethers.deployContract("EtherReceiver__MockForLidoRedeems", [await lido.getAddress()], deployer);

      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(500n);
      await lido.setStETHRedeemer(await redeemer.getAddress());
      await processReport();

      const redeemerAddr = await redeemer.getAddress();
      const reserveAmount = await lido.getRedeemsReserve();
      await lido.transfer(redeemerAddr, reserveAmount);
    });

    it("should revert when amount is zero", async () => {
      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await expect(redeemer.callRedeemStETH(0n)).to.be.revertedWith("ZERO_AMOUNT");

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should revert when caller is not the redeemer", async () => {
      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await expect(lido.connect(stranger).redeemStETH(ether("1.0"))).to.be.revertedWith("APP_AUTH_FAILED");

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should revert when contract is stopped", async () => {
      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await lido.stop();
      await expect(redeemer.callRedeemStETH(ether("1.0"))).to.be.revertedWith("CONTRACT_IS_STOPPED");

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should revert when bunker mode is active", async () => {
      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await withdrawalQueue.mock__isBunkerModeActive(true);
      await expect(redeemer.callRedeemStETH(ether("1.0"))).to.be.revertedWith("BUNKER_MODE");

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should revert when withdrawal queue is paused", async () => {
      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await withdrawalQueue.mock__isPaused(true);
      await expect(redeemer.callRedeemStETH(ether("1.0"))).to.be.revertedWith("WQ_PAUSED");

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should revert when amount exceeds reserve", async () => {
      const reserve = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await expect(redeemer.callRedeemStETH(reserve + 1n)).to.be.revertedWith("RESERVE_LIMIT_REACHED");

      expect(await lido.getRedeemsReserve()).to.equal(reserve);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should redeem stETH for exact ETH amount and preserve share rate", async () => {
      const redeemAmount = ether("1.0");
      const redeemerAddr = await redeemer.getAddress();

      const totalSharesBefore = await lido.getTotalShares();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const shareRateBefore = (totalPooledBefore * BigInt(1e27)) / totalSharesBefore;
      const redeemerStETHBefore = await lido.balanceOf(redeemerAddr);
      const bufferedBefore = await lido.getBufferedEther();
      const reserveBefore = await lido.getRedeemsReserve();
      const redeemerEthBefore = await ethers.provider.getBalance(redeemerAddr);

      const sharesAmount = await lido.getSharesByPooledEth(redeemAmount);
      const etherAmount = await lido.getPooledEthByShares(sharesAmount);

      await expect(redeemer.callRedeemStETH(redeemAmount))
        .to.emit(lido, "StETHRedeemed")
        .withArgs(redeemerAddr, redeemAmount, sharesAmount, etherAmount);

      expect(await lido.balanceOf(redeemerAddr)).to.be.lt(redeemerStETHBefore);
      expect(await lido.getBufferedEther()).to.be.approximately(bufferedBefore - redeemAmount, 100n);
      expect(await lido.getRedeemsReserve()).to.be.approximately(reserveBefore - redeemAmount, 100n);
      expect(await ethers.provider.getBalance(redeemerAddr)).to.be.approximately(
        redeemerEthBefore + redeemAmount,
        100n,
      );
      expect(await lido.getTotalPooledEther()).to.be.approximately(totalPooledBefore - redeemAmount, 100n);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore - sharesAmount);

      const totalSharesAfter = await lido.getTotalShares();
      const totalPooledAfter = await lido.getTotalPooledEther();
      const shareRateAfter = (totalPooledAfter * BigInt(1e27)) / totalSharesAfter;

      expect(shareRateAfter).to.be.gte(shareRateBefore);
      expect(shareRateAfter - shareRateBefore).to.be.lte(1n);
    });

    it("should emit SharesBurnt event on successful redeem", async () => {
      const redeemAmount = ether("1.0");
      const redeemerAddr = await redeemer.getAddress();
      const sharesAmount = await lido.getSharesByPooledEth(redeemAmount);
      const etherAmount = await lido.getPooledEthByShares(sharesAmount);

      await expect(redeemer.callRedeemStETH(redeemAmount))
        .to.emit(lido, "SharesBurnt")
        .withArgs(redeemerAddr, etherAmount, etherAmount, sharesAmount);
    });

    it("should emit RedeemsReserveSet event on successful redeem", async () => {
      const redeemAmount = ether("1.0");
      const sharesAmount = await lido.getSharesByPooledEth(redeemAmount);
      const etherAmount = await lido.getPooledEthByShares(sharesAmount);
      const storedReserve = await lido.getRedeemsReserve();

      await expect(redeemer.callRedeemStETH(redeemAmount))
        .to.emit(lido, "RedeemsReserveSet")
        .withArgs(storedReserve - etherAmount);
    });

    it("should revert when redeemer has no stETH balance", async () => {
      const freshRedeemer = await ethers.deployContract(
        "EtherReceiver__MockForLidoRedeems",
        [await lido.getAddress()],
        deployer,
      );
      await lido.setStETHRedeemer(await freshRedeemer.getAddress());

      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await expect(freshRedeemer.callRedeemStETH(ether("1.0"))).to.be.reverted;

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should revert when ETH transfer to redeemer fails", async () => {
      const reserveBefore = await lido.getRedeemsReserve();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      await redeemer.mock__rejectEther(true);
      await expect(redeemer.callRedeemStETH(ether("1.0"))).to.be.reverted;

      expect(await lido.getRedeemsReserve()).to.equal(reserveBefore);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore);
    });

    it("should redeem the entire reserve and set it to zero", async () => {
      const reserve = await lido.getRedeemsReserve();
      const redeemerAddr = await redeemer.getAddress();
      const bufferedBefore = await lido.getBufferedEther();
      const totalPooledBefore = await lido.getTotalPooledEther();
      const totalSharesBefore = await lido.getTotalShares();

      const redeemerBalance = await lido.balanceOf(redeemerAddr);
      expect(redeemerBalance).to.be.gte(reserve);

      const sharesForReserve = await lido.getSharesByPooledEth(reserve);
      const etherForReserve = await lido.getPooledEthByShares(sharesForReserve);

      await expect(redeemer.callRedeemStETH(reserve)).to.emit(lido, "StETHRedeemed");
      expect(await lido.getRedeemsReserve()).to.equal(0n);
      expect(await lido.getBufferedEther()).to.equal(bufferedBefore - etherForReserve);
      expect(await lido.getTotalPooledEther()).to.equal(totalPooledBefore - etherForReserve);
      expect(await lido.getTotalShares()).to.equal(totalSharesBefore - sharesForReserve);
    });
  });

  context("getters", () => {
    it("should return 0 for getRedeemsReserveTargetRatio by default", async () => {
      expect(await lido.getRedeemsReserveTargetRatio()).to.equal(0n);
    });

    it("should return 0 for getRedeemsReserveTarget when ratio is 0", async () => {
      expect(await lido.getRedeemsReserveTarget()).to.equal(0n);
    });

    it("should compute getRedeemsReserveTarget as internalEther * ratio / 10000", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      await lido.setRedeemsReserveTargetRatio(500n);

      const internalEther = await lido.getTotalPooledEther();
      expect(await lido.getRedeemsReserveTarget()).to.equal((internalEther * 500n) / 10000n);
    });

    it("should return 0 for getRedeemsReserveTarget after submit when ratio is still 0", async () => {
      await lido.submit(ZeroAddress, { value: ether("100.0") });
      expect(await lido.getRedeemsReserveTarget()).to.equal(0n);
    });

    it("should return 0 for getRedeemsReserve when no reserve is set", async () => {
      expect(await lido.getRedeemsReserve()).to.equal(0n);
    });

    it("should return 0 for getRedeemsReserveGrowthShare by default", async () => {
      expect(await lido.getRedeemsReserveGrowthShare()).to.equal(0n);
    });

    it("should return zero address for getStETHRedeemer by default", async () => {
      expect(await lido.getStETHRedeemer()).to.equal(ZeroAddress);
    });
  });
});
