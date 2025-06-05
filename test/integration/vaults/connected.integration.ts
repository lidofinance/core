import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, LazyOracle, StakingVault, VaultHub } from "typechain-types";

import { advanceChainTime, days, ether, impersonate, randomAddress } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLido,
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

    await setupLido(ctx);

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

      expect(await lido.getCurrentStakeLimit()).to.equal(0); // <-- no more limit

      await dashboard.connect(roles.funder).fund({ value: ether("2") }); // try to fund to go healthy
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
      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // total value is 2 ether
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));
      const etherToRebalance = ether(".5");
      const sharesBurnt = await ctx.contracts.lido.getSharesByPooledEth(etherToRebalance);

      await expect(dashboard.connect(roles.rebalancer).rebalanceVault(etherToRebalance))
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
        vaultHub,
        "InsufficientTotalValueToMint",
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
      const maxElClRewardsBP = await lazyOracle.maxElClRewardsBP();

      const smallValue = (ether("1") * maxElClRewardsBP) / 10000n; // small % of the total value

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + smallValue);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(smallValue + ether("1")); // 1 ether is locked in the vault
    });

    it("Should not allow huge CL/EL rewards totalValue increase without quarantine", async () => {
      const value = ether("1000");

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault
    });

    it("Quarantine happy path", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // middle of quarantine period ---------------------------
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod / 2n);

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
    });

    it("Safe deposit in quarantine period - before last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // safe deposit in the middle of quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod / 2n);

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await reportVaultDataWithProof(ctx, stakingVault, ether("2") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
    });

    it("Safe deposit in quarantine period - after last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // end of quarantine period ------------------------------
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod + 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      // safe deposit after last refslot
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
    });

    it("Withdrawal in quarantine period - before last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // safe deposit and withdrawal in the middle of quarantine period
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.3"));
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7"));

      // end of quarantine period ------------------------------
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod + 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await reportVaultDataWithProof(ctx, stakingVault, ether("1.7") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
    });

    it("Withdrawal in quarantine period - after last refslot", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // safe deposit in the middle of quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod / 2n);
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));

      await advanceChainTime(quarantinePeriod / 2n - 60n * 60n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(false);

      await reportVaultDataWithProof(ctx, stakingVault, ether("2") + value);

      const [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();

      // end of quarantine period ------------------------------
      await advanceChainTime(60n * 60n * 2n);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      //check that refslot is increased
      const [refSlot2] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(refSlot2).to.be.greaterThan(refSlot);

      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.3"));
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7"));

      await reportVaultDataWithProof(ctx, stakingVault, ether("2") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.7") + value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
    });

    it("EL/CL rewards during quarantine period", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      const [lastReportTimestamp, ,] = await lazyOracle.latestReportData();

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);

      // rewards in the middle of quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod / 2n);

      const maxElClRewardsBP = await lazyOracle.maxElClRewardsBP();
      const rewardsValue = (ether("1") * maxElClRewardsBP) / 10000n;

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value + rewardsValue);
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(0);
      expect(quarantine.lastUnsafeFundDelta).to.equal(0);

      // end of quarantine period ------------------------------
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, ether("1") + value + rewardsValue);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1") + value + rewardsValue);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(lastReportTimestamp);
    });

    it("Sequential quarantine with unsafe fund", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, value);
      const [firstReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value - ether("1"));
      expect(quarantine.startTs).to.equal(firstReportTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(0);
      expect(quarantine.lastUnsafeFundDelta).to.equal(0);

      // total value UNSAFE increase in the middle of quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod / 2n);

      await reportVaultDataWithProof(ctx, stakingVault, value * 2n);
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      const [secondQuarantineTimestamp, ,] = await lazyOracle.latestReportData();

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value - ether("1"));
      expect(quarantine.startTs).to.equal(firstReportTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundDelta).to.equal(value * 2n - ether("1"));

      // end of first quarantine = start of second quarantine
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, value * 2n);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundDelta).to.equal(value * 2n - ether("1"));

      // end of second quarantine
      await advanceChainTime(quarantinePeriod);

      await reportVaultDataWithProof(ctx, stakingVault, value * 2n);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value * 2n);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundDelta).to.equal(value * 2n - ether("1"));
    });

    it("Sequential quarantine with EL/CL rewards", async () => {
      const value = ether("1000");

      // start of quarantine period ----------------------------
      await reportVaultDataWithProof(ctx, stakingVault, value);
      const [firstReportTimestamp, ,] = await lazyOracle.latestReportData();
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1")); // 1 ether is locked in the vault

      let quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value - ether("1"));
      expect(quarantine.startTs).to.equal(firstReportTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(0);
      expect(quarantine.lastUnsafeFundDelta).to.equal(0);

      // rewards in the middle of quarantine period
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      await advanceChainTime(quarantinePeriod / 2n);

      const maxElClRewardsBP = await lazyOracle.maxElClRewardsBP();
      const rewardsValue = (ether("1") * maxElClRewardsBP) / 10000n;

      await reportVaultDataWithProof(ctx, stakingVault, value + rewardsValue);
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1"));

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value - ether("1"));
      expect(quarantine.startTs).to.equal(firstReportTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(0);
      expect(quarantine.lastUnsafeFundDelta).to.equal(0);

      // end of first quarantine = start of second quarantine
      await advanceChainTime(quarantinePeriod / 2n + 60n * 60n);

      await reportVaultDataWithProof(ctx, stakingVault, value * 2n);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value);
      const [secondQuarantineTimestamp, ,] = await lazyOracle.latestReportData();

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(value);
      expect(quarantine.startTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(0);
      expect(quarantine.lastUnsafeFundDelta).to.equal(0);

      // end of second quarantine
      await advanceChainTime(quarantinePeriod);

      await reportVaultDataWithProof(ctx, stakingVault, value * 2n);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(value * 2n);

      quarantine = await lazyOracle.vaultQuarantine(stakingVault);
      expect(quarantine.delta).to.equal(0);
      expect(quarantine.startTs).to.equal(secondQuarantineTimestamp);
      expect(quarantine.lastUnsafeFundTs).to.equal(0);
      expect(quarantine.lastUnsafeFundDelta).to.equal(0);
    });

    it("Sanity check for dynamic total value underflow", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await reportVaultDataWithProof(ctx, stakingVault);

      await advanceChainTime(days(1n));

      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.1"));

      // int256(_totalValue) + curInOutDelta - _inOutDelta < 0
      await expect(reportVaultDataWithProof(ctx, stakingVault, 0n))
        .to.be.revertedWithCustomError(lazyOracle, "UnderflowInTotalValueCalculation");
    });

    it("Sanity check for liability shares increase", async () => {
      const connection = await vaultHub.vaultConnection(stakingVault);
      const shareLimit = connection.shareLimit;

      await expect(reportVaultDataWithProof(ctx, stakingVault, ether("1"), shareLimit + ether("1")))
        .to.be.revertedWithCustomError(lazyOracle, "LiabilitySharesExceedsLimit");
    });

    it("InOutDelta cache in fund", async () => {
      const value = ether("1.234");
      
      await advanceChainTime(days(2n));

      // first deposit in frame
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cachedInOutDelta).to.equal(0);
      expect(record.cachedRefSlot).to.equal(0);

      await dashboard.connect(roles.funder).fund({ value: value });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cachedInOutDelta).to.equal(ether("1"));
      let [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(record.cachedRefSlot).to.equal(refSlot);

      // second deposit in frame
      await dashboard.connect(roles.funder).fund({ value: value });

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cachedInOutDelta).to.equal(ether("1"));
      expect(record.cachedRefSlot).to.equal(refSlot);
    });

    it("InOutDelta cache in withdraw", async () => {
      const value = ether("1.234");

      await dashboard.connect(roles.funder).fund({ value: value });

      let [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      let record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cachedInOutDelta).to.equal(ether("1"));
      expect(record.cachedRefSlot).to.equal(refSlot);

      await advanceChainTime(days(2n));
      await reportVaultDataWithProof(ctx, stakingVault);

      // first withdraw in frame
      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.1"));

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cachedInOutDelta).to.equal(value + ether("1"));
      [refSlot] = await ctx.contracts.hashConsensus.getCurrentFrame();
      expect(record.cachedRefSlot).to.equal(refSlot);

      // second withdraw in frame
      await dashboard.connect(roles.withdrawer).withdraw(stranger, ether("0.1"));

      record = await vaultHub.vaultRecord(stakingVault);
      expect(record.cachedInOutDelta).to.equal(value + ether("1"));
      expect(record.cachedRefSlot).to.equal(refSlot);
    });
  });

  // skipping for now, going to update these tests later
  describe("If vault is unhealthy", () => {
    beforeEach(async () => {
      console.log(await vaultHub.vaultRecord(stakingVault));
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      console.log(await vaultHub.vaultRecord(stakingVault));
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));
      console.log(await vaultHub.vaultRecord(stakingVault));

      await reportVaultDataWithProof(ctx, stakingVault, TEST_STETH_AMOUNT_WEI);

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(false);
    });

    it("Can't mint until goes healthy", async () => {
      console.log(await vaultHub.vaultRecord(stakingVault));

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.be.revertedWithCustomError(vaultHub, "InsufficientTotalValueToMint")
        .withArgs(await stakingVault.getAddress(), ether("1") + TEST_STETH_AMOUNT_WEI); // inOutDelta diff + testSharesAmountWei is from the report

      await dashboard.connect(roles.funder).fund({ value: ether("2") });
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true);

      // = (1 ether locked * 100%) / 80% = 1.25 ether
      const reserve = ether("0.25");
      const testAmountWithRatio = (TEST_STETH_AMOUNT_WEI * 100n) / 80n;

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, ether("1") + reserve + testAmountWithRatio);
    });
  });
});
