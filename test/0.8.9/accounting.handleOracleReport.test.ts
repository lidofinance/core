import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { getStorageAt, setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Accounting,
  ACL,
  Burner__MockForAccounting,
  Burner__MockForAccounting__factory,
  IPostTokenRebaseReceiver,
  Lido,
  LidoExecutionLayerRewardsVault__MockForLidoAccounting,
  LidoExecutionLayerRewardsVault__MockForLidoAccounting__factory,
  LidoLocator,
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
import { ReportValuesStruct } from "typechain-types/contracts/0.8.9/oracle/AccountingOracle.sol/IReportReceiver";

import { certainAddress, ether, getNextBlockTimestamp, impersonate, streccak } from "lib";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";

describe("Accounting.sol:report", () => {
  let deployer: HardhatEthersSigner;
  let stethWhale: HardhatEthersSigner;

  let lido: Lido;
  let acl: ACL;
  let accounting: Accounting;
  let postTokenRebaseReceiver: IPostTokenRebaseReceiver;
  let locator: LidoLocator;

  let elRewardsVault: LidoExecutionLayerRewardsVault__MockForLidoAccounting;
  let withdrawalVault: WithdrawalVault__MockForLidoAccounting;
  let stakingRouter: StakingRouter__MockForLidoAccounting;
  let oracleReportSanityChecker: OracleReportSanityChecker__MockForAccounting;
  let withdrawalQueue: WithdrawalQueue__MockForAccounting;
  let burner: Burner__MockForAccounting;

  beforeEach(async () => {
    [deployer, stethWhale] = await ethers.getSigners();

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

    ({ lido, acl, accounting } = await deployLidoDao({
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

    locator = LidoLocator__factory.connect(await lido.getLidoLocator(), deployer);

    const accountingOracleSigner = await impersonate(await locator.accountingOracle(), ether("100.0"));
    accounting = accounting.connect(accountingOracleSigner);

    await acl.createPermission(deployer, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(deployer, lido, await lido.PAUSE_ROLE(), deployer);
    await acl.createPermission(deployer, lido, await lido.UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE(), deployer);
    await lido.resume();
  });

  context("handleOracleReport", () => {
    it("Update CL validators count if reported more", async () => {
      let depositedValidators = 100n;
      await lido.connect(deployer).unsafeChangeDepositedValidators(depositedValidators);

      // first report, 100 validators
      await accounting.handleOracleReport(
        report({
          clValidators: depositedValidators,
        }),
      );

      const slot = streccak("lido.Lido.beaconValidators");
      const lidoAddress = await lido.getAddress();

      let clValidatorsPosition = await getStorageAt(lidoAddress, slot);
      expect(clValidatorsPosition).to.equal(depositedValidators);

      depositedValidators = 101n;
      await lido.connect(deployer).unsafeChangeDepositedValidators(depositedValidators);

      // second report, 101 validators
      await accounting.handleOracleReport(
        report({
          clValidators: depositedValidators,
        }),
      );

      clValidatorsPosition = await getStorageAt(lidoAddress, slot);
      expect(clValidatorsPosition).to.equal(depositedValidators);
    });

    it("Reverts if the `checkAccountingOracleReport` sanity check fails", async () => {
      await oracleReportSanityChecker.mock__checkAccountingOracleReportReverts(true);

      await expect(accounting.handleOracleReport(report())).to.be.reverted;
    });

    it("Reverts if the `checkWithdrawalQueueOracleReport` sanity check fails", async () => {
      await oracleReportSanityChecker.mock__checkWithdrawalQueueOracleReportReverts(true);
      await expect(
        accounting.handleOracleReport(
          report({
            withdrawalFinalizationBatches: [1n],
          }),
        ),
      ).to.be.reverted;
    });

    it("Does not revert if the `checkWithdrawalQueueOracleReport` sanity check fails but no withdrawal batches were reported", async () => {
      await oracleReportSanityChecker.mock__checkWithdrawalQueueOracleReportReverts(true);
      await withdrawalQueue.mock__isPaused(true);

      await expect(accounting.handleOracleReport(report())).not.to.be.reverted;
    });

    /// NOTE: This test is not applicable to the current implementation (Accounting's _checkAccountingOracleReport() checks for checkWithdrawalQueueOracleReport()
    /// explicitly in case _report.withdrawalFinalizationBatches.length > 0
    // it("Does not revert if the `checkWithdrawalQueueOracleReport` sanity check fails but `withdrawalQueue` is paused", async () => {
    //   await oracleReportSanityChecker.mock__checkWithdrawalQueueOracleReportReverts(true);
    //   await withdrawalQueue.mock__isPaused(true);

    //   await expect(accounting.handleOracleReport(report({ withdrawalFinalizationBatches: [1n] }))).not.to.be.reverted;
    // });

    it("Does not emit `StETHBurnRequested` if there are no shares to burn", async () => {
      await expect(
        accounting.handleOracleReport(
          report({
            withdrawalFinalizationBatches: [1n],
          }),
        ),
      ).not.to.emit(burner, "StETHBurnRequested");
    });

    it("Emits `StETHBurnRequested` if there are shares to burn", async () => {
      const sharesToBurn = 1n;
      const isCover = false;
      const steth = 1n * 2n; // imitating 1:2 rate, see Burner `mock__prefinalizeReturn`

      await withdrawalQueue.mock__prefinalizeReturn(0n, sharesToBurn);

      await expect(
        accounting.handleOracleReport(
          report({
            withdrawalFinalizationBatches: [1n],
          }),
        ),
      )
        .to.emit(burner, "StETHBurnRequested")
        .withArgs(isCover, await accounting.getAddress(), steth, sharesToBurn);
    });

    it("Withdraws ether from `ElRewardsVault` if EL rewards are greater than 0 as returned from `smoothenTokenRebase`", async () => {
      const withdrawals = 0n;
      const elRewards = 1n;
      const simulatedSharesToBurn = 0n;
      const sharesToBurn = 0n;

      await oracleReportSanityChecker.mock__smoothenTokenRebaseReturn(
        withdrawals,
        elRewards,
        simulatedSharesToBurn,
        sharesToBurn,
      );

      // `Mock__RewardsWithdrawn` event is only emitted on the mock to verify
      // that `ElRewardsVault.withdrawRewards` was actually called
      await expect(accounting.handleOracleReport(report())).to.emit(elRewardsVault, "Mock__RewardsWithdrawn");
    });

    it("Withdraws ether from `WithdrawalVault` if withdrawals are greater than 0 as returned from `smoothenTokenRebase`", async () => {
      const withdrawals = 1n;
      const elRewards = 0n;
      const simulatedSharesToBurn = 0n;
      const sharesToBurn = 0n;

      await oracleReportSanityChecker.mock__smoothenTokenRebaseReturn(
        withdrawals,
        elRewards,
        simulatedSharesToBurn,
        sharesToBurn,
      );
      const totalFee = 1000;
      const precisionPoints = 10n ** 20n;
      await stakingRouter.mock__getStakingRewardsDistribution([], [], [], totalFee, precisionPoints);

      // `Mock__WithdrawalsWithdrawn` event is only emitted on the mock to verify
      // that `WithdrawalVault.withdrawWithdrawals` was actually called
      await expect(accounting.handleOracleReport(report())).to.emit(withdrawalVault, "Mock__WithdrawalsWithdrawn");
    });

    it("Finalizes withdrawals if there is ether to lock on `WithdrawalQueue` as returned from `prefinalize`", async () => {
      const ethToLock = ether("10.0");
      await withdrawalQueue.mock__prefinalizeReturn(ethToLock, 0n);
      // top up buffer via submit
      await lido.submit(ZeroAddress, { value: ethToLock });

      await expect(
        accounting.handleOracleReport(
          report({
            withdrawalFinalizationBatches: [1n, 2n],
          }),
        ),
      ).to.emit(withdrawalQueue, "WithdrawalsFinalized");
    });

    it("Updates buffered ether", async () => {
      const initialBufferedEther = await lido.getBufferedEther();
      const ethToLock = 1n;

      // assert that the buffer has enough eth to lock for withdrawals
      // should have some eth from the initial 0xdead holder
      expect(initialBufferedEther).greaterThanOrEqual(ethToLock);
      await withdrawalQueue.mock__prefinalizeReturn(ethToLock, 0n);

      await expect(
        accounting.handleOracleReport(
          report({
            withdrawalFinalizationBatches: [1n],
          }),
        ),
      ).to.not.be.reverted;

      expect(await lido.getBufferedEther()).to.equal(initialBufferedEther - ethToLock);
    });

    it("Emits an `ETHDistributed` event", async () => {
      const reportTimestamp = await getNextBlockTimestamp();
      const preClBalance = 0n;
      const clBalance = 1n;
      const withdrawals = 0n;
      const elRewards = 0n;
      const bufferedEther = await lido.getBufferedEther();

      const totalFee = 1000;
      const precisionPoints = 10n ** 20n;
      await stakingRouter.mock__getStakingRewardsDistribution([], [], [], totalFee, precisionPoints);

      await expect(
        accounting.handleOracleReport(
          report({
            timestamp: reportTimestamp,
            clBalance,
          }),
        ),
      )
        .to.emit(lido, "ETHDistributed")
        .withArgs(reportTimestamp, preClBalance, clBalance, withdrawals, elRewards, bufferedEther);
    });

    it("Burns shares if there are shares to burn as returned from `smoothenTokenRebaseReturn`", async () => {
      const sharesRequestedToBurn = 1n;

      await oracleReportSanityChecker.mock__smoothenTokenRebaseReturn(0n, 0n, 0n, sharesRequestedToBurn);

      // set up steth whale, in case we need to send steth to other accounts
      await setBalance(stethWhale.address, ether("101.0"));
      await lido.connect(stethWhale).submit(ZeroAddress, { value: ether("100.0") });
      // top up Burner with steth to burn
      await lido.connect(stethWhale).transferShares(burner, sharesRequestedToBurn);

      await expect(
        accounting.handleOracleReport(
          report({
            sharesRequestedToBurn,
          }),
        ),
      ).to.emit(burner, "Mock__CommitSharesToBurnWasCalled");

      // TODO: SharesBurnt event is not emitted anymore because of the mock implementation
      // .and.to.emit(lido, "SharesBurnt")
      // .withArgs(await burner.getAddress(), sharesRequestedToBurn, sharesRequestedToBurn, sharesRequestedToBurn);
    });

    it("Reverts if the number of reward recipients does not match the number of module fees as returned from `StakingRouter.getStakingRewardsDistribution`", async () => {
      // one recipient
      const recipients = [certainAddress("lido:handleOracleReport:single-recipient")];
      const modulesIds = [1n, 2n];
      // but two module fees
      const moduleFees = [500n, 500n];
      const totalFee = 1000;
      const precisionPoints = 10n ** 20n;

      await stakingRouter.mock__getStakingRewardsDistribution(
        recipients,
        modulesIds,
        moduleFees,
        totalFee,
        precisionPoints,
      );

      await expect(
        accounting.handleOracleReport(
          report({
            clBalance: 1n, // made 1 wei of profit, trigers reward processing
          }),
        ),
      )
        .to.be.revertedWithCustomError(accounting, "UnequalArrayLengths")
        .withArgs(1, 2);
    });

    it("Reverts if the number of module ids does not match the number of module fees as returned from `StakingRouter.getStakingRewardsDistribution`", async () => {
      const recipients = [
        certainAddress("lido:handleOracleReport:recipient1"),
        certainAddress("lido:handleOracleReport:recipient2"),
      ];
      // one module id
      const modulesIds = [1n];
      // but two module fees
      const moduleFees = [500n, 500n];
      const totalFee = 1000;
      const precisionPoints = 10n ** 20n;

      await stakingRouter.mock__getStakingRewardsDistribution(
        recipients,
        modulesIds,
        moduleFees,
        totalFee,
        precisionPoints,
      );

      await expect(
        accounting.handleOracleReport(
          report({
            clBalance: 1n, // made 1 wei of profit, trigers reward processing
          }),
        ),
      )
        .to.be.revertedWithCustomError(accounting, "UnequalArrayLengths")
        .withArgs(1, 2);
    });

    it("Does not mint and transfer any shares if the total fee is zero as returned from `StakingRouter.getStakingRewardsDistribution`", async () => {
      // single staking module
      const recipients = [certainAddress("lido:handleOracleReport:recipient")];
      const modulesIds = [1n];
      const moduleFees = [500n];
      // fee is 0
      const totalFee = 0;
      const precisionPoints = 10n ** 20n;

      await stakingRouter.mock__getStakingRewardsDistribution(
        recipients,
        modulesIds,
        moduleFees,
        totalFee,
        precisionPoints,
      );

      await expect(
        accounting.handleOracleReport(
          report({
            clBalance: 1n,
          }),
        ),
      )
        .not.to.emit(lido, "Transfer")
        .and.not.to.emit(lido, "TransferShares")
        .and.not.to.emit(stakingRouter, "Mock__MintedRewardsReported");
    });

    it("Mints shares to itself and then transfers them to recipients if there are fees to distribute as returned from `StakingRouter.getStakingRewardsDistribution`", async () => {
      // initially, before any rebases, one share costs one steth
      expect(await lido.getPooledEthByShares(ether("1.0"))).to.equal(ether("1.0"));
      // thus, the total supply of steth should equal the total number of shares
      expect(await lido.getTotalPooledEther()).to.equal(await lido.getTotalShares());

      // mock a single staking module with 5% fee with the total protocol fee of 10%
      const stakingModule = {
        address: certainAddress("lido:handleOracleReport:staking-module"),
        id: 1n,
        fee: 5n * 10n ** 18n, // 5%
      };

      const totalFee = 10n * 10n ** 18n; // 10%
      const precisionPoints = 100n * 10n ** 18n; // 100%

      await stakingRouter.mock__getStakingRewardsDistribution(
        [stakingModule.address],
        [stakingModule.id],
        [stakingModule.fee],
        totalFee,
        precisionPoints,
      );

      const clBalance = ether("1.0");

      const expectedSharesToMint =
        (clBalance * totalFee * (await lido.getTotalShares())) /
        (((await lido.getTotalPooledEther()) + clBalance) * precisionPoints - clBalance * totalFee);

      const expectedModuleRewardInShares = expectedSharesToMint / (totalFee / stakingModule.fee);
      const expectedTreasuryCutInShares = expectedSharesToMint - expectedModuleRewardInShares;

      await expect(
        accounting.handleOracleReport(
          report({
            clBalance: ether("1.0"), // 1 ether of profit
          }),
        ),
      )
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, stakingModule.address, expectedModuleRewardInShares)
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, await lido.getTreasury(), expectedTreasuryCutInShares)
        .and.to.emit(stakingRouter, "Mock__MintedRewardsReported");

      expect(await lido.balanceOf(stakingModule.address)).to.equal(
        await lido.getPooledEthByShares(expectedModuleRewardInShares),
      );

      expect(await lido.balanceOf(await lido.getTreasury())).to.equal(
        await lido.getPooledEthByShares(expectedTreasuryCutInShares),
      );

      // now one share should cost 1.9 steth (10% was distributed as rewards)
      expect(await lido.getPooledEthByShares(ether("1.0"))).to.equal(ether("1.9"));
    });

    it("Transfers all new shares to treasury if the module fee is zero as returned `StakingRouter.getStakingRewardsDistribution`", async () => {
      // initially, before any rebases, one share costs one steth
      expect(await lido.getPooledEthByShares(ether("1.0"))).to.equal(ether("1.0"));
      // thus, the total supply of steth should equal the total number of shares
      expect(await lido.getTotalPooledEther()).to.equal(await lido.getTotalShares());

      // mock a single staking module with 0% fee with the total protocol fee of 10%
      const stakingModule = {
        address: certainAddress("lido:handleOracleReport:staking-module"),
        id: 1n,
        fee: 0n,
      };

      const totalFee = 10n * 10n ** 18n; // 10%
      const precisionPoints = 100n * 10n ** 18n; // 100%

      await stakingRouter.mock__getStakingRewardsDistribution(
        [stakingModule.address],
        [stakingModule.id],
        [stakingModule.fee],
        totalFee,
        precisionPoints,
      );

      const clBalance = ether("1.0");

      const expectedSharesToMint =
        (clBalance * totalFee * (await lido.getTotalShares())) /
        (((await lido.getTotalPooledEther()) + clBalance) * precisionPoints - clBalance * totalFee);

      const expectedModuleRewardInShares = 0n;
      const expectedTreasuryCutInShares = expectedSharesToMint;

      await expect(
        accounting.handleOracleReport(
          report({
            clBalance: ether("1.0"), // 1 ether of profit
          }),
        ),
      )
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, await lido.getTreasury(), expectedTreasuryCutInShares)
        .and.to.emit(stakingRouter, "Mock__MintedRewardsReported");

      expect(await lido.balanceOf(stakingModule.address)).to.equal(
        await lido.getPooledEthByShares(expectedModuleRewardInShares),
      );

      expect(await lido.balanceOf(await lido.getTreasury())).to.equal(
        await lido.getPooledEthByShares(expectedTreasuryCutInShares),
      );

      // now one share should cost 1.9 steth (10% was distributed as rewards)
      expect(await lido.getPooledEthByShares(ether("1.0"))).to.equal(ether("1.9"));
    });

    it("Relays the report data to `PostTokenRebaseReceiver`", async () => {
      await expect(accounting.handleOracleReport(report())).to.emit(
        postTokenRebaseReceiver,
        "Mock__PostTokenRebaseHandled",
      );
    });

    it("Does not relay the report data to `PostTokenRebaseReceiver` if the locator returns zero address", async () => {
      const lidoLocatorAddress = await lido.getLidoLocator();

      // Change the locator implementation to support zero address
      await updateLidoLocatorImplementation(lidoLocatorAddress, {}, "LidoLocator__MockMutable", deployer);
      const locatorMutable = await ethers.getContractAt("LidoLocator__MockMutable", lidoLocatorAddress, deployer);
      await locatorMutable.mock___updatePostTokenRebaseReceiver(ZeroAddress);

      expect(await locator.postTokenRebaseReceiver()).to.equal(ZeroAddress);

      const accountingOracleAddress = await locator.accountingOracle();
      const accountingOracle = await impersonate(accountingOracleAddress, ether("1000.0"));

      await expect(accounting.connect(accountingOracle).handleOracleReport(report())).not.to.emit(
        postTokenRebaseReceiver,
        "Mock__PostTokenRebaseHandled",
      );
    });

    function report(overrides?: Partial<ReportValuesStruct>): ReportValuesStruct {
      return {
        timestamp: 0n,
        timeElapsed: 0n,
        clValidators: 0n,
        clBalance: 0n,
        withdrawalVaultBalance: 0n,
        elRewardsVaultBalance: 0n,
        sharesRequestedToBurn: 0n,
        withdrawalFinalizationBatches: [],
        vaultValues: [],
        netCashFlows: [],
        ...overrides,
      };
    }
  });
});
