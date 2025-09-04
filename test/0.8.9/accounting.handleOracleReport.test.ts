import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  Accounting,
  Burner__MockForAccounting,
  Burner__MockForAccounting__factory,
  IPostTokenRebaseReceiver,
  Lido__MockForAccounting,
  Lido__MockForAccounting__factory,
  LidoLocator,
  OracleReportSanityChecker__MockForAccounting,
  OracleReportSanityChecker__MockForAccounting__factory,
  PostTokenRebaseReceiver__MockForAccounting__factory,
  StakingRouter__MockForLidoAccounting,
  StakingRouter__MockForLidoAccounting__factory,
  VaultHub__MockForAccountingReport,
  VaultHub__MockForAccountingReport__factory,
  WithdrawalQueue__MockForAccounting,
  WithdrawalQueue__MockForAccounting__factory,
} from "typechain-types";
import { ReportValuesStruct } from "typechain-types/contracts/0.8.9/oracle/AccountingOracle.sol/IReportReceiver";

import { certainAddress, ether, getCurrentBlockTimestamp, impersonate } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";

describe("Accounting.sol:report", () => {
  let deployer: HardhatEthersSigner;

  let accounting: Accounting;
  let postTokenRebaseReceiver: IPostTokenRebaseReceiver;
  let locator: LidoLocator;

  let lido: Lido__MockForAccounting;
  let stakingRouter: StakingRouter__MockForLidoAccounting;
  let oracleReportSanityChecker: OracleReportSanityChecker__MockForAccounting;
  let withdrawalQueue: WithdrawalQueue__MockForAccounting;
  let burner: Burner__MockForAccounting;
  let vaultHub: VaultHub__MockForAccountingReport;

  beforeEach(async () => {
    [deployer] = await ethers.getSigners();

    [lido, stakingRouter, oracleReportSanityChecker, postTokenRebaseReceiver, withdrawalQueue, burner, vaultHub] =
      await Promise.all([
        new Lido__MockForAccounting__factory(deployer).deploy(),
        new StakingRouter__MockForLidoAccounting__factory(deployer).deploy(),
        new OracleReportSanityChecker__MockForAccounting__factory(deployer).deploy(),
        new PostTokenRebaseReceiver__MockForAccounting__factory(deployer).deploy(),
        new WithdrawalQueue__MockForAccounting__factory(deployer).deploy(),
        new Burner__MockForAccounting__factory(deployer).deploy(),
        new VaultHub__MockForAccountingReport__factory(deployer).deploy(),
      ]);

    locator = await deployLidoLocator(
      {
        lido,
        stakingRouter,
        oracleReportSanityChecker,
        postTokenRebaseReceiver,
        withdrawalQueue,
        burner,
        vaultHub,
      },
      deployer,
    );

    const accountingImpl = await ethers.deployContract("Accounting", [locator, lido], deployer);
    const accountingProxy = await ethers.deployContract(
      "OssifiableProxy",
      [accountingImpl, deployer, new Uint8Array()],
      deployer,
    );
    accounting = await ethers.getContractAt("Accounting", accountingProxy, deployer);
    await updateLidoLocatorImplementation(await locator.getAddress(), { accounting });

    const accountingOracleSigner = await impersonate(await locator.accountingOracle(), ether("100.0"));
    accounting = accounting.connect(accountingOracleSigner);
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
      simulatedShareRate: 10n ** 27n,
      ...overrides,
    };
  }

  context("simulateOracleReport", () => {
    it("should not revert if the report is not valid", async () => {
      const preTotalPooledEther = await lido.getTotalPooledEther();
      const preTotalShares = await lido.getTotalShares();

      const simulated = await accounting.simulateOracleReport(report());

      expect(simulated.withdrawalsVaultTransfer).to.equal(0n);
      expect(simulated.elRewardsVaultTransfer).to.equal(0n);
      expect(simulated.etherToFinalizeWQ).to.equal(0n);
      expect(simulated.sharesToFinalizeWQ).to.equal(0n);
      expect(simulated.sharesToBurnForWithdrawals).to.equal(0n);
      expect(simulated.totalSharesToBurn).to.equal(0n);
      expect(simulated.sharesToMintAsFees).to.equal(0n);
      expect(simulated.feeDistribution.moduleFeeRecipients).to.deep.equal([]);
      expect(simulated.feeDistribution.moduleIds).to.deep.equal([]);
      expect(simulated.feeDistribution.moduleSharesToMint).to.deep.equal([]);
      expect(simulated.feeDistribution.treasurySharesToMint).to.equal(0n);
      expect(simulated.principalClBalance).to.equal(0n);
      expect(simulated.postInternalShares).to.equal(preTotalShares);
      expect(simulated.postInternalEther).to.equal(preTotalPooledEther);
      expect(simulated.postTotalShares).to.equal(preTotalShares);
      expect(simulated.postTotalPooledEther).to.equal(preTotalPooledEther);
    });
  });

  context("handleOracleReport", () => {
    it("Update CL validators count if reported more", async () => {
      let depositedValidators = 100n;
      await lido.mock__setDepositedValidators(depositedValidators);

      // first report, 100 validators
      await accounting.handleOracleReport(
        report({
          clValidators: depositedValidators,
        }),
      );
      expect(await lido.reportClValidators()).to.equal(depositedValidators);

      depositedValidators = 101n;
      await lido.mock__setDepositedValidators(depositedValidators);

      // second report, 101 validators
      await accounting.handleOracleReport(
        report({
          clValidators: depositedValidators,
        }),
      );
      expect(await lido.reportClValidators()).to.equal(depositedValidators);
    });

    it("Reverts if the `checkAccountingOracleReport` sanity check fails", async () => {
      await oracleReportSanityChecker.mock__checkAccountingOracleReportReverts(true);

      await expect(accounting.handleOracleReport(report())).to.be.revertedWithCustomError(
        oracleReportSanityChecker,
        "CheckAccountingOracleReportReverts",
      );
    });

    it("Reverts if the `checkWithdrawalQueueOracleReport` sanity check fails", async () => {
      await oracleReportSanityChecker.mock__checkWithdrawalQueueOracleReportReverts(true);
      await expect(
        accounting.handleOracleReport(
          report({
            withdrawalFinalizationBatches: [1n],
          }),
        ),
      ).to.be.revertedWithCustomError(oracleReportSanityChecker, "CheckWithdrawalQueueOracleReportReverts");
    });

    it("Reverts if the report timestamp is incorrect", async () => {
      const currentTimestamp = await getCurrentBlockTimestamp();
      const incorrectTimestamp = currentTimestamp + 1000n; // Future timestamp

      await expect(
        accounting.handleOracleReport(
          report({
            timestamp: incorrectTimestamp,
          }),
        ),
      ).to.be.revertedWithCustomError(accounting, "IncorrectReportTimestamp");
    });

    it("Reverts if the reported validators count is less than the current count", async () => {
      const depositedValidators = 100n;
      await expect(
        accounting.handleOracleReport(
          report({
            clValidators: depositedValidators,
          }),
        ),
      )
        .to.be.revertedWithCustomError(accounting, "IncorrectReportValidators")
        .withArgs(100n, 0n, 0n);
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
      ).not.to.emit(burner, "Mock__StETHBurnRequested");
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
            simulatedShareRate: 10n ** 27n,
          }),
        ),
      )
        .to.emit(burner, "Mock__StETHBurnRequested")
        .withArgs(isCover, await accounting.getAddress(), steth, sharesToBurn);
    });

    it("ensures that `Lido.collectRewardsAndProcessWithdrawals` is called from `Accounting`", async () => {
      // `Mock__CollectRewardsAndProcessWithdrawals` event is only emitted on the mock to verify
      // that `Lido.collectRewardsAndProcessWithdrawals` was actually called
      await expect(accounting.handleOracleReport(report())).to.emit(lido, "Mock__CollectRewardsAndProcessWithdrawals");
    });

    it("Burns shares if there are shares to burn as returned from `smoothenTokenRebaseReturn`", async () => {
      const sharesRequestedToBurn = 1n;
      await oracleReportSanityChecker.mock__smoothenTokenRebaseReturn(0n, 0n, 0n, sharesRequestedToBurn);

      await expect(
        accounting.handleOracleReport(
          report({
            sharesRequestedToBurn,
          }),
        ),
      )
        .to.emit(burner, "Mock__CommitSharesToBurnWasCalled")
        .withArgs(sharesRequestedToBurn);
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
            clBalance: 1n, // made 1 wei of profit, triggers reward processing
          }),
        ),
      ).to.be.revertedWithPanic(0x01); // assert
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
            clBalance: 1n, // made 1 wei of profit, triggers reward processing
          }),
        ),
      ).to.be.revertedWithPanic(0x01); // assert
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
      ).not.to.emit(stakingRouter, "Mock__MintedRewardsReported");
    });

    it("Mints shares to itself and then transfers them to recipients if there are fees to distribute as returned from `StakingRouter.getStakingRewardsDistribution`", async () => {
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
        .withArgs(ZeroAddress, await locator.treasury(), expectedTreasuryCutInShares)
        .and.to.emit(stakingRouter, "Mock__MintedRewardsReported");
    });

    it("Transfers all new shares to treasury if the module fee is zero as returned `StakingRouter.getStakingRewardsDistribution`", async () => {
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

      const expectedTreasuryCutInShares = expectedSharesToMint;

      await expect(
        accounting.handleOracleReport(
          report({
            clBalance: ether("1.0"), // 1 ether of profit
          }),
        ),
      )
        .and.to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, await locator.treasury(), expectedTreasuryCutInShares)
        .and.to.emit(stakingRouter, "Mock__MintedRewardsReported");
    });

    it("Relays the report data to `PostTokenRebaseReceiver`", async () => {
      await expect(accounting.handleOracleReport(report())).to.emit(
        postTokenRebaseReceiver,
        "Mock__PostTokenRebaseHandled",
      );
    });

    it("Does not relay the report data to `PostTokenRebaseReceiver` if the locator returns zero address", async () => {
      const lidoLocatorAddress = await locator.getAddress();

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
  });
});
