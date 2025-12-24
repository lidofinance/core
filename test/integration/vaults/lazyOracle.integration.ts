import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, LazyOracle, StakingVault, VaultHub } from "typechain-types";

import { advanceChainTime, days, ether, getCurrentBlockTimestamp, impersonate, randomAddress } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  report,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";
import { calculateLockedValue, createVaultsReportTree, VaultReportItem } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

describe("Integration: LazyOracle", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;
  let lazyOracle: LazyOracle;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    await report(ctx);

    ({ vaultHub, lazyOracle } = ctx.contracts);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with an operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true, "Report is fresh after setup");
    expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true, "Vault is healthy after setup");
  });

  describe("Reporting", () => {
    it("bringing new AO report makes vault report unfresh", async () => {
      await report(ctx);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);
    });

    it("bringing no report for 2 days makes vault report unfresh", async () => {
      await advanceChainTime(days(1n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      await advanceChainTime(days(1n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);
    });

    context("average vault report", () => {
      let vaultReport: VaultReportItem;

      beforeEach(async () => {
        const { lido } = ctx.contracts;

        await dashboard.fund({ value: ether("1") });
        await dashboard.mintShares(owner, 13001n);
        await lido.approve(dashboard, 2n);
        await dashboard.burnShares(1n);

        const totalValueArg = ether("2");
        const cumulativeLidoFeesArg = ether("0.1");
        const liabilitySharesArg = 13000n;
        const maxLiabilitySharesArg = 13001n;
        const slashingReserveArg = ether("1.5");

        vaultReport = {
          vault: await stakingVault.getAddress(),
          totalValue: totalValueArg,
          cumulativeLidoFees: cumulativeLidoFeesArg,
          liabilityShares: liabilitySharesArg,
          maxLiabilityShares: maxLiabilitySharesArg,
          slashingReserve: slashingReserveArg,
        };
      });

      it("reverts if maxLiabilityShares is less than liabilityShares", async () => {
        await expect(
          reportVaultDataWithProof(ctx, stakingVault, { maxLiabilityShares: 12999n }),
        ).to.be.revertedWithCustomError(lazyOracle, "InvalidMaxLiabilityShares");
      });

      it("reverts if maxLiabilityShares is greater than the currently tracked on-chain record.maxLiabilityShares", async () => {
        await expect(
          reportVaultDataWithProof(ctx, stakingVault, { maxLiabilityShares: 13002n }),
        ).to.be.revertedWithCustomError(lazyOracle, "InvalidMaxLiabilityShares");
      });

      it("updates report data and check for all the parameters and events", async () => {
        const { locator, hashConsensus } = ctx.contracts;

        await advanceChainTime(days(2n));
        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

        const reportTimestampArg = await getCurrentBlockTimestamp();
        const reportRefSlotArg = (await hashConsensus.getCurrentFrame()).refSlot;

        const reportTree = createVaultsReportTree([vaultReport]);
        const accountingSigner = await impersonate(await locator.accountingOracle(), ether("100"));
        await expect(
          lazyOracle
            .connect(accountingSigner)
            .updateReportData(reportTimestampArg, reportRefSlotArg, reportTree.root, ""),
        )
          .to.emit(lazyOracle, "VaultsReportDataUpdated")
          .withArgs(reportTimestampArg, reportRefSlotArg, reportTree.root, "");

        await expect(
          lazyOracle.updateVaultData(
            stakingVault,
            vaultReport.totalValue,
            vaultReport.cumulativeLidoFees,
            vaultReport.liabilityShares,
            vaultReport.maxLiabilityShares,
            vaultReport.slashingReserve,
            reportTree.getProof(0),
          ),
        )
          .to.emit(vaultHub, "VaultReportApplied")
          .withArgs(
            stakingVault,
            reportTimestampArg,
            vaultReport.totalValue,
            vaultReport.totalValue, // inOutDelta
            vaultReport.cumulativeLidoFees,
            vaultReport.liabilityShares,
            vaultReport.maxLiabilityShares,
            vaultReport.slashingReserve,
          );

        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

        const record = await vaultHub.vaultRecord(stakingVault);
        expect(record.report.totalValue).to.equal(ether("2"));
        expect(record.report.inOutDelta).to.equal(ether("2"));
        expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));
        expect(record.report.timestamp).to.equal(reportTimestampArg);
        expect(record.minimalReserve).to.equal(vaultReport.slashingReserve);
        expect(record.maxLiabilityShares).to.equal(13000n);
        expect(await vaultHub.locked(stakingVault)).to.equal(
          await calculateLockedValue(ctx, stakingVault, {
            liabilityShares: 13000n,
            minimalReserve: vaultReport.slashingReserve,
            reserveRatioBP: (await vaultHub.vaultConnection(stakingVault)).reserveRatioBP,
          }),
        );
      });
    });
  });

  describe("Outdated report", () => {
    beforeEach(async () => {
      // Spoil the report freshness
      await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
      await dashboard.fund({ value: ether("1") });

      const maxStakeLimit = ether("0.5");
      const sender = await impersonate(randomAddress(), maxStakeLimit + ether("1"));
      await sender.sendTransaction({
        to: await stakingVault.getAddress(),
        value: maxStakeLimit,
      });

      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));
    });

    it("Can't mint until brings the fresh report", async () => {
      const { lido } = ctx.contracts;

      await expect(dashboard.mintStETH(stranger, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );

      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      await expect(dashboard.mintStETH(stranger, ether("2.1"))).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );

      const etherToMint = ether("0.1");
      const sharesToMint = await lido.getSharesByPooledEth(etherToMint);
      await expect(dashboard.mintStETH(stranger, etherToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, sharesToMint, ether("1") + (await lido.getPooledEthBySharesRoundUp(sharesToMint)));
    });

    it("Can't withdraw until brings the fresh report", async () => {
      await expect(dashboard.withdraw(stranger, ether("0.3"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );

      await reportVaultDataWithProof(ctx, stakingVault);

      await expect(dashboard.withdraw(stranger, ether("0.3")))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, ether("0.3"));
    });
  });

  describe("Lazy reporting sanity checker", () => {
    beforeEach(async () => {
      // Spoil the report freshness
      await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));
    });

    it("Forbids double reporting", async () => {
      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      await expect(
        reportVaultDataWithProof(ctx, stakingVault, { updateReportData: false }),
      ).to.be.revertedWithCustomError(lazyOracle, "VaultReportIsFreshEnough");
    });

    it("Forbids double reporting even if report is stale", async () => {
      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await expect(
        reportVaultDataWithProof(ctx, stakingVault, { updateReportData: false }),
      ).to.be.revertedWithCustomError(lazyOracle, "VaultReportIsFreshEnough");
    });

    it("Should allow huge totalValue increase using SAFE funding", async () => {
      const hugeValue = ether("1000");

      await dashboard.fund({ value: hugeValue });

      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(hugeValue + ether("1")); // 1 ether is locked in the vault
    });

    it("Should allow CL/EL rewards totalValue increase without quarantine", async () => {
      const maxRewardRatioBP = await lazyOracle.maxRewardRatioBP();

      const smallValue = (ether("1") * maxRewardRatioBP) / 10000n; // small % of the total value

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + smallValue });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(smallValue + ether("1")); // 1 ether is locked in the vault
    });

    it("Sanity check for dynamic total value underflow", async () => {
      await dashboard.fund({ value: ether("1") });

      await advanceChainTime(days(1n));

      await reportVaultDataWithProof(ctx, stakingVault);

      await advanceChainTime(days(1n));

      await dashboard.withdraw(stranger, ether("0.1"));

      // int256(_totalValue) + curInOutDelta - _inOutDelta < 0
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: 0n })).to.be.revertedWithCustomError(
        lazyOracle,
        "UnderflowInTotalValueCalculation",
      );
    });

    it("Gift and withdraw causing underflow on slashed vault", async () => {
      // This test is to reproduce the underflow vulnerability reported in https://github.com/lidofinance/core/issues/1342
      const INITIAL_FUND = ether("1000");
      const SLASHED_AMOUNT = ether("5");
      const GIFT_AMOUNT = ether("996");

      // Step 1: Fund the vault with 1000 ETH and report it
      await dashboard.fund({ value: INITIAL_FUND - ether("1") });
      await advanceChainTime(days(1n));
      await reportVaultDataWithProof(ctx, stakingVault);

      // Advance time for next report slot
      await advanceChainTime(days(1n));

      // Step 2: Gift the vault 996 ETH directly (bypassing fund() to not update inOutDelta)
      await owner.sendTransaction({
        to: await stakingVault.getAddress(),
        value: GIFT_AMOUNT,
      });

      // Step 3: Withdraw 996 ETH (this decreases current inOutDelta but keeps previous refSlot inOutDelta high)
      await dashboard.withdraw(stranger, GIFT_AMOUNT);

      // Step 4: Try to update with slashed total value
      const slashedTotalValue = INITIAL_FUND - SLASHED_AMOUNT;

      // This calculation should underflow:
      // totalValueWithoutQuarantine + currentInOutDelta - inOutDeltaOnRefSlot
      // = 995 + 4 ETH - 1000 ETH
      await expect(
        reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: slashedTotalValue,
          waitForNextRefSlot: false,
        }),
      ).to.be.revertedWithCustomError(lazyOracle, "UnderflowInTotalValueCalculation");

      // if attacker continues to repeat this, the freshness condition would prevent withdrawals
      await advanceChainTime(days(2n));
      await expect(dashboard.withdraw(stranger, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );

      // but it works after waiting for next refSlot
      await expect(
        reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: slashedTotalValue,
          waitForNextRefSlot: true,
        }),
      ).to.not.be.reverted;
    });

    it("InOutDelta cache in fund", async () => {
      const value = ether("1.234");

      await advanceChainTime(days(2n));

      // first deposit in frame
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[0].refSlot).to.equal(0n);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[1].refSlot).to.equal(0);

      await dashboard.fund({ value: value });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[0].refSlot).to.equal(0n);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      const [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot);

      // second deposit in frame
      await dashboard.fund({ value: value });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot);
    });

    it("InOutDelta cache in withdraw", async () => {
      const value = ether("1.234");

      await dashboard.fund({ value: value });

      let [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot);

      await advanceChainTime(days(2n));
      await reportVaultDataWithProof(ctx, stakingVault);

      // first withdraw in frame
      await dashboard.withdraw(stranger, ether("0.1"));

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(value + ether("1"));
      [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(record.inOutDelta[0].refSlot).to.equal(refSlot);

      // second withdraw in frame
      await dashboard.withdraw(stranger, ether("0.1"));

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(value + ether("1"));
      expect(record.inOutDelta[0].refSlot).to.equal(refSlot);
    });

    it("Reporting for previous frame", async () => {
      // FRAME 0 -----------------------------------------------
      // check starting values
      const [refSlot0] = await ctx.contracts.hashConsensus.getCurrentFrame();
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].value).to.equal(ether("1"));
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[0].refSlot).to.equal(0);
      expect(record.inOutDelta[1].value).to.equal(0);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[1].refSlot).to.equal(0);
      expect(record.report.totalValue).to.equal(ether("1"));
      expect(record.report.inOutDelta).to.equal(ether("1"));

      // wait for next frame
      let refSlot1 = refSlot0;
      while (refSlot1 === refSlot0) {
        await advanceChainTime(60n * 60n);
        [refSlot1] = await ctx.contracts.hashConsensus.getCurrentFrame();
      }
      expect(refSlot1).to.be.greaterThan(refSlot0);
      const reportTimestamp1 = await getCurrentBlockTimestamp();

      // FRAME 1 -----------------------------------------------
      // fund in frame 1 - init cache
      await dashboard.fund({ value: ether("10") });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[1].value).to.equal(ether("11"));
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot1);

      // wait for next frame
      let refSlot2 = refSlot1;
      while (refSlot2 === refSlot1) {
        await advanceChainTime(60n * 60n);
        [refSlot2] = await ctx.contracts.hashConsensus.getCurrentFrame();
      }
      expect(refSlot2).to.be.greaterThan(refSlot1);

      // FRAME 2 -----------------------------------------------
      // report for refSlot 1
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        reportTimestamp: reportTimestamp1,
        reportRefSlot: refSlot1,
      });

      // check that report inOutDelta is correct on chain
      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.report.totalValue).to.equal(ether("1"));
      expect(record.report.inOutDelta).to.equal(ether("1"));
    });

    it("Should revert if reporting for previous frame with changed inOutDelta cache (fund after next refSlot)", async () => {
      // FRAME 0 -----------------------------------------------
      // check starting values
      const [refSlot0] = await ctx.contracts.hashConsensus.getCurrentFrame();
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].value).to.equal(ether("1"));
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[0].refSlot).to.equal(0);
      expect(record.inOutDelta[1].value).to.equal(0);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[1].refSlot).to.equal(0);
      expect(record.report.totalValue).to.equal(ether("1"));
      expect(record.report.inOutDelta).to.equal(ether("1"));

      // wait for next frame
      let refSlot1 = refSlot0;
      while (refSlot1 === refSlot0) {
        await advanceChainTime(60n * 60n);
        [refSlot1] = await ctx.contracts.hashConsensus.getCurrentFrame();
      }
      expect(refSlot1).to.be.greaterThan(refSlot0);
      const reportTimestamp1 = await getCurrentBlockTimestamp();

      // FRAME 1 -----------------------------------------------
      // fund in frame 1 - init cache
      await dashboard.fund({ value: ether("10") });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[1].value).to.equal(ether("11"));
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot1);

      // wait for next frame
      let refSlot2 = refSlot1;
      while (refSlot2 === refSlot1) {
        await advanceChainTime(60n * 60n);
        [refSlot2] = await ctx.contracts.hashConsensus.getCurrentFrame();
      }
      expect(refSlot2).to.be.greaterThan(refSlot1);
      const reportTimestamp2 = await getCurrentBlockTimestamp();

      // FRAME 2 -----------------------------------------------
      // fund in frame 2
      await dashboard.fund({ value: ether("10") });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].value).to.equal(ether("21"));
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(ether("11"));
      expect(record.inOutDelta[0].refSlot).to.equal(refSlot2);

      // report for refSlot 1 with changed inOutDelta cache
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        reportTimestamp: reportTimestamp1,
        reportRefSlot: refSlot1,
      });

      // check that report inOutDelta is correct on chain
      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.report.totalValue).to.equal(ether("1"));
      expect(record.report.inOutDelta).to.equal(ether("1"));

      // report for refSlot 2
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("11"),
        reportTimestamp: reportTimestamp2,
        reportRefSlot: refSlot2,
      });

      // check that report inOutDelta is correct on chain
      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.report.totalValue).to.equal(ether("11"));
      expect(record.report.inOutDelta).to.equal(ether("11"));
    });

    describe("Cumulative Lido fees sanity checks", () => {
      beforeEach(async () => {
        // Set up initial state with some settled fees to test against
        await reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("5") });

        // Advance time to make reports stale again for subsequent tests
        await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);
      });

      it("Should reject report with cumulative Lido fees too low", async () => {
        // Current cumulative fees are 5 ETH, trying to report 3 ETH should fail
        await expect(reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("3") }))
          .to.be.revertedWithCustomError(lazyOracle, "CumulativeLidoFeesTooLow")
          .withArgs(ether("3"), ether("5"));
      });

      it("Should accept report with same cumulative Lido fees (no change)", async () => {
        // Same cumulative fees should be accepted
        await expect(reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: ether("5") })).to.not.be
          .reverted;

        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      });

      it("Should accept report with valid cumulative Lido fees increase within rate limit", async () => {
        const maxLidoFeeRatePerSecond = await lazyOracle.maxLidoFeeRatePerSecond();
        const timeDelta = 3600n; // 1 hour
        const maxFeeIncrease = maxLidoFeeRatePerSecond * timeDelta;
        const validFeeIncrease = maxFeeIncrease / 2n; // Half of max allowed

        // Report with timestamp 1 hour later and valid fee increase
        await expect(
          reportVaultDataWithProof(ctx, stakingVault, {
            cumulativeLidoFees: ether("5") + validFeeIncrease,
            reportTimestamp: (await lazyOracle.latestReportTimestamp()) + timeDelta,
          }),
        ).to.not.be.reverted;

        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

        const record = await vaultHub.vaultRecord(stakingVault);
        expect(record.cumulativeLidoFees).to.equal(ether("5") + validFeeIncrease);
      });

      it("Should reject report with cumulative Lido fees increase exceeding rate limit", async () => {
        const maxLidoFeeRatePerSecond = await lazyOracle.maxLidoFeeRatePerSecond();
        const timeDelta = 3600n; // 1 hour
        const maxFeeIncrease = maxLidoFeeRatePerSecond * timeDelta;
        const excessiveFeeIncrease = maxFeeIncrease + ether("1"); // Exceed limit by 1 ETH

        await expect(
          reportVaultDataWithProof(ctx, stakingVault, {
            cumulativeLidoFees: ether("5") + excessiveFeeIncrease,
            reportTimestamp: (await lazyOracle.latestReportTimestamp()) + timeDelta,
          }),
        )
          .to.be.revertedWithCustomError(lazyOracle, "CumulativeLidoFeesTooLarge")
          .withArgs(excessiveFeeIncrease, maxFeeIncrease);
      });

      it("Should handle edge case: exactly at maximum allowed fee rate", async () => {
        const maxLidoFeeRatePerSecond = await lazyOracle.maxLidoFeeRatePerSecond();
        const timeDelta = 3600n; // 1 hour
        const maxFeeIncrease = maxLidoFeeRatePerSecond * timeDelta;

        // Report with exactly the maximum allowed fee increase
        await expect(
          reportVaultDataWithProof(ctx, stakingVault, {
            cumulativeLidoFees: ether("5") + maxFeeIncrease,
            reportTimestamp: (await lazyOracle.latestReportTimestamp()) + timeDelta,
          }),
        ).to.not.be.reverted;

        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      });

      it("Should handle large time delta with proportional fee increase", async () => {
        const maxLidoFeeRatePerSecond = await lazyOracle.maxLidoFeeRatePerSecond();
        const timeDelta = 365n * 24n * 60n * 60n; // 1 year
        const maxFeeIncrease = maxLidoFeeRatePerSecond * timeDelta;
        const validFeeIncrease = maxFeeIncrease - ether("1"); // Just under the limit

        await advanceChainTime(timeDelta);

        await expect(
          reportVaultDataWithProof(ctx, stakingVault, {
            cumulativeLidoFees: ether("5") + validFeeIncrease,
          }),
        ).to.not.be.reverted;

        const record = await vaultHub.vaultRecord(stakingVault);
        expect(record.cumulativeLidoFees).to.equal(ether("5") + validFeeIncrease);

        expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      });
    });
  });
});
