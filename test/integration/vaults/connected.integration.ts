import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, LazyOracle, StakingVault, VaultHub } from "typechain-types";

import {
  advanceChainTime,
  days,
  ether,
  getCurrentBlockTimestamp,
  impersonate,
  randomAddress,
  TOTAL_BASIS_POINTS,
} from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
const TEST_STETH_AMOUNT_WEI = 100n;

describe("Integration: Actions with vault connected to VaultHub", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;
  let lazyOracle: LazyOracle;

  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  let testSharesAmountWei: bigint;

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    ({ vaultHub, lazyOracle } = ctx.contracts);

    [owner, nodeOperator, stranger, pauser] = await ethers.getSigners();

    // Owner can create a vault with an operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));

    agent = await ctx.getSigner("agent");

    testSharesAmountWei = await ctx.contracts.lido.getSharesByPooledEth(TEST_STETH_AMOUNT_WEI);

    await reportVaultDataWithProof(ctx, stakingVault);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true, "Report is fresh after setup");
    expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true, "Vault is healthy after setup");
  });

  it("VaultHub is pausable and resumable", async () => {
    await vaultHub.connect(agent).grantRole(await vaultHub.PAUSE_ROLE(), pauser);
    await vaultHub.connect(agent).grantRole(await vaultHub.RESUME_ROLE(), pauser);

    expect(await vaultHub.isPaused()).to.equal(false);

    await expect(vaultHub.connect(pauser).pauseFor(100000n)).to.emit(vaultHub, "Paused");
    expect(await vaultHub.isPaused()).to.equal(true);

    // check that minting is paused
    await expect(
      dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI),
    ).to.be.revertedWithCustomError(vaultHub, "ResumedExpected");

    await expect(vaultHub.connect(pauser).resume()).to.emit(vaultHub, "Resumed");
    expect(await vaultHub.isPaused()).to.equal(false);

    // check that minting is resumed
    await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(stakingVault, testSharesAmountWei, ether("1"));
  });

  context("stETH minting", () => {
    it("Allows minting stETH", async () => {
      // add some stETH to the vault to have totalValue
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, ether("1"));
    });

    // TODO: can mint within share limits of the vault
    // Need to check VaultHub.shareLimit for the vault and try to mint more than that

    // can mint over Lido Core share limit
    it("Can mint stETH over v2 limit", async () => {
      const { lido } = ctx.contracts;
      const maxStakeLimit = await lido.getCurrentStakeLimit();
      const sender = await impersonate(randomAddress(), maxStakeLimit + ether("1"));

      await lido.connect(sender).submit(sender, { value: maxStakeLimit });
      const newLimit = await lido.getCurrentStakeLimit();

      await dashboard.connect(roles.funder).fund({ value: newLimit + ether("2") }); // try to fund to go healthy
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, ether("1"));
    });
  });

  context("stETH burning", () => {
    it("Allows burning stETH", async () => {
      const { lido } = ctx.contracts;

      // add some stETH to the vault to have totalValue, mint shares and approve stETH
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintStETH(roles.burner, TEST_STETH_AMOUNT_WEI);
      await lido.connect(roles.burner).approve(dashboard, TEST_STETH_AMOUNT_WEI);

      await expect(dashboard.connect(roles.burner).burnStETH(TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei);
    });

    // Can burn steth from the lido v2 core protocol
    // 1. Mint some stETH
    // 2. transfer stETH to some other address
    // 3. try to burn stETH, get reject that nothing to burn
    // 4. submit some ether to lido (v2 core protocol) lido.submit(sender, { value: amount })
    // 5. try to burn stETH again, now it should work
  });

  context("Validator ejection", () => {
    it("Vault owner can request validator(s) exit", async () => {
      const keys = getPubkeys(2);

      await expect(dashboard.connect(roles.validatorExitRequester).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[0], keys.pubkeys[0])
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[1], keys.pubkeys[1]);
    });

    it("Allows trigger validator withdrawal for vault owner", async () => {
      await expect(
        dashboard
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [ether("1")], 0, roles.validatorWithdrawalTriggerer);
    });

    it("Does not allow trigger validator withdrawal for node operator", async () => {
      await expect(
        stakingVault
          .connect(nodeOperator)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
      )
        .to.be.revertedWithCustomError(stakingVault, "OwnableUnauthorizedAccount")
        .withArgs(nodeOperator.address);
    });

    it("Allows trigger validator ejection for node operator", async () => {
      await expect(stakingVault.connect(nodeOperator).ejectValidators(SAMPLE_PUBKEY, nodeOperator, { value: 1n }))
        .to.emit(stakingVault, "ValidatorEjectionsTriggered")
        .withArgs(SAMPLE_PUBKEY, 0n, nodeOperator);
    });
  });

  context("Rebalancing", () => {
    it("Owner can rebalance debt to the protocol", async () => {
      const { lido } = ctx.contracts;

      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // total value is 2 ether
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));

      const sharesBurnt = await vaultHub.liabilityShares(stakingVault);
      const etherToRebalance = await lido.getPooledEthBySharesRoundUp(sharesBurnt);

      await expect(dashboard.connect(roles.rebalancer).rebalanceVaultWithShares(sharesBurnt))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(vaultHub, etherToRebalance)
        .to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .withArgs(stakingVault, ether("2") - etherToRebalance)
        .to.emit(ctx.contracts.lido, "ExternalEtherTransferredToBuffer")
        .withArgs(etherToRebalance)
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(stakingVault, sharesBurnt, etherToRebalance);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2") - etherToRebalance);
    });
  });

  describe("Reporting", () => {
    it("updates report data and keep in fresh state for 1 day", async () => {
      await advanceChainTime(days(1n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
    });
  });

  describe("Outdated report", () => {
    beforeEach(async () => {
      // Spoil the report freshness
      await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

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
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );

      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, ether("2.1"))).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );

      const etherToMint = ether("0.1");
      const sharesToMint = await ctx.contracts.lido.getSharesByPooledEth(etherToMint);
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, etherToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, sharesToMint, ether("1"));
    });

    it("Can't withdraw until brings the fresh report", async () => {
      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.3"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );

      await reportVaultDataWithProof(ctx, stakingVault);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.3")))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, ether("0.3"));
    });

    // TODO: add later
    it.skip("Can't triggerValidatorWithdrawal", () => {});
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

      await dashboard.connect(roles.funder).fund({ value: hugeValue });

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

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

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
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
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
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.3"));
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
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
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

      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.3"));
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
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await reportVaultDataWithProof(ctx, stakingVault);

      await advanceChainTime(days(1n));

      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.1"));

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
      expect(record.inOutDelta[0].refSlot).to.equal(1n);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[1].refSlot).to.equal(0);

      await dashboard.connect(roles.funder).fund({ value: value });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(0);
      expect(record.inOutDelta[0].refSlot).to.equal(1n);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      const [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot);

      // second deposit in frame
      await dashboard.connect(roles.funder).fund({ value: value });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot);
    });

    it("InOutDelta cache in withdraw", async () => {
      const value = ether("1.234");

      await dashboard.connect(roles.funder).fund({ value: value });

      let [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[1].valueOnRefSlot).to.equal(ether("1"));
      expect(record.inOutDelta[1].refSlot).to.equal(refSlot);

      await advanceChainTime(days(2n));
      await reportVaultDataWithProof(ctx, stakingVault);

      // first withdraw in frame
      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.1"));

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.inOutDelta[0].valueOnRefSlot).to.equal(value + ether("1"));
      [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(record.inOutDelta[0].refSlot).to.equal(refSlot);

      // second withdraw in frame
      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.1"));

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
      expect(record.inOutDelta[0].refSlot).to.equal(1);
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
      await dashboard.connect(roles.funder).fund({ value: ether("10") });

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
      expect(record.inOutDelta[0].refSlot).to.equal(1);
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
      await dashboard.connect(roles.funder).fund({ value: ether("10") });

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
      await dashboard.connect(roles.funder).fund({ value: ether("10") });

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

  // skipping for now, going to update these tests later
  describe("If vault is unhealthy", () => {
    it("Can't mint until goes healthy", async () => {
      const { lido } = ctx.contracts;
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: TEST_STETH_AMOUNT_WEI }); // slashing
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(false);
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.be.revertedWithCustomError(dashboard, "ExceedsMintingCapacity")
        .withArgs(testSharesAmountWei, 0);

      await dashboard.connect(roles.funder).fund({ value: ether("2") });
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true);

      // calculate the lock increase amount
      const liabilityShares = (await vaultHub.vaultRecord(stakingVault)).liabilityShares + testSharesAmountWei;
      const liability = await lido.getPooledEthBySharesRoundUp(liabilityShares);
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVault)).reserveRatioBP;
      const lock = (liability * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - reserveRatioBP);

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, lock);
    });
  });
});
