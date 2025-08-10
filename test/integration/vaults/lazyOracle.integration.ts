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
import { createVaultsReportTree, VaultReportItem } from "lib/protocol/helpers/vaults";

import { Snapshot } from "test/suite";

describe("Integration: LazyOracle", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;
  let lazyOracle: LazyOracle;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;

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
    it("bringing no report for 2 days makes vault report unfresh", async () => {
      await advanceChainTime(days(1n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      await advanceChainTime(days(1n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);
    });

    it("updates report data and check for all the parameters and events", async () => {
      await advanceChainTime(days(2n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      const { locator, hashConsensus } = ctx.contracts;

      const totalValueArg = ether("1");
      const accruedLidoFeesArg = ether("0.1");
      const liabilitySharesArg = 13000n;
      const slashingReserveArg = ether("1.5");
      const reportTimestampArg = await getCurrentBlockTimestamp();
      const reportRefSlotArg = (await hashConsensus.getCurrentFrame()).refSlot;

      const vaultReport: VaultReportItem = {
        vault: await stakingVault.getAddress(),
        totalValue: totalValueArg,
        accruedLidoFees: accruedLidoFeesArg,
        liabilityShares: liabilitySharesArg,
        slashingReserve: slashingReserveArg,
      };
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
          await stakingVault.getAddress(),
          totalValueArg,
          accruedLidoFeesArg,
          liabilitySharesArg,
          slashingReserveArg,
          reportTree.getProof(0),
        ),
      )
        .to.emit(vaultHub, "VaultReportApplied")
        .withArgs(
          stakingVault,
          reportTimestampArg,
          totalValueArg,
          ether("1"),
          accruedLidoFeesArg,
          liabilitySharesArg,
          slashingReserveArg,
        );

      const record = await vaultHub.vaultRecord(stakingVault);
      expect(record.report.totalValue).to.equal(ether("1"));
      expect(record.locked).to.equal(ether("1"));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
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
      const sharesToMint = await ctx.contracts.lido.getSharesByPooledEth(etherToMint);
      await expect(dashboard.mintStETH(stranger, etherToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, sharesToMint, ether("1"));
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

    it("Should not allow huge CL/EL rewards totalValue increase without quarantine", async () => {
      const value = ether("1000");

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault
    });

    it("Quarantine happy path", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(lastReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // middle of quarantine period ---------------------------
      await advanceChainTime(quarantinePeriod / 2n);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("Safe deposit in quarantine period - before last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(lastReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // safe deposit in the middle of quarantine period
      await advanceChainTime(quarantinePeriod / 2n);

      await dashboard.fund({ value: ether("1") });

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("2") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("Safe deposit in quarantine period - after last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(lastReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod + 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      // safe deposit after last refslot
      await dashboard.fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("Withdrawal in quarantine period - before last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(lastReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // safe deposit and withdrawal in the middle of quarantine period
      await dashboard.fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.withdraw(stranger, ether("0.3"));
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7"));

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod + 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1.7") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("Withdrawal in quarantine period - after last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(lastReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // safe deposit in the middle of quarantine period
      await advanceChainTime(quarantinePeriod / 2n);
      await dashboard.fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await advanceChainTime(quarantinePeriod / 2n - 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("2") + value });

      const [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();

      // end of quarantine period ------------------------------
      //check that refslot is increased
      let refSlot2 = refSlot;
      while (refSlot2 === refSlot) {
        await advanceChainTime(60n * 60n * 2n);
        [refSlot2] = await ctx.contracts.hashConsensus.getCurrentFrame();
      }
      expect(refSlot2).to.be.greaterThan(refSlot);

      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      await dashboard.withdraw(stranger, ether("0.3"));
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7"));

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("2") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("EL/CL rewards during quarantine period", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(lastReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // rewards in the middle of quarantine period
      await advanceChainTime(quarantinePeriod / 2n);

      const maxRewardRatioBP = await lazyOracle.maxRewardRatioBP();
      const rewardsValue = (ether("1") * maxRewardRatioBP) / 10000n;

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value + rewardsValue });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(lastReportTimestamp);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1") + value + rewardsValue });
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1") + value + rewardsValue);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("Sequential quarantine with unsafe fund", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value });
      const [firstReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value - ether("1"));
      expect(quarantine.startTimestamp).to.equal(firstReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(firstReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // total value UNSAFE increase in the middle of quarantine period
      await advanceChainTime(quarantinePeriod / 2n);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value * 2n });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value - ether("1"));
      expect(quarantine.startTimestamp).to.equal(firstReportTimestamp);

      // end of first quarantine = start of second quarantine
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value * 2n });
      const [secondQuarantineTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(secondQuarantineTimestamp);

      // end of second quarantine
      await advanceChainTime(quarantinePeriod);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value * 2n });

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value * 2n);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
    });

    it("Sequential quarantine with EL/CL rewards", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value });
      const [firstReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantine.pendingTotalValueIncrease).to.equal(value - ether("1"));
      expect(quarantine.startTimestamp).to.equal(firstReportTimestamp);
      expect(quarantine.endTimestamp).to.equal(firstReportTimestamp + quarantinePeriod);
      expect(quarantine.isActive).to.equal(true);

      // rewards in the middle of quarantine period
      await advanceChainTime(quarantinePeriod / 2n);

      const maxRewardRatioBP = await lazyOracle.maxRewardRatioBP();
      const rewardsValue = (ether("1") * maxRewardRatioBP) / 10000n;

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value + rewardsValue });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value - ether("1"));
      expect(quarantine.startTimestamp).to.equal(firstReportTimestamp);

      // end of first quarantine = start of second quarantine
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value * 2n });

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value);
      const [secondQuarantineTimestamp, ,] = await lazyOracle.latestReportData();

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(value);
      expect(quarantine.startTimestamp).to.equal(secondQuarantineTimestamp);

      // end of second quarantine
      await advanceChainTime(quarantinePeriod);

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: value * 2n });

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value * 2n);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.pendingTotalValueIncrease).to.equal(0);
      expect(quarantine.startTimestamp).to.equal(0);
      expect(quarantine.isActive).to.equal(false);
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
  });
});
