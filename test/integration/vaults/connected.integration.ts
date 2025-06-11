import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

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

    ({ vaultHub } = ctx.contracts);

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

  // skipping for now, going to update these tests later
  describe("If vault is unhealthy", () => {
    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));

      await reportVaultDataWithProof(ctx, stakingVault, TEST_STETH_AMOUNT_WEI);

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(false);
    });

    it("Can't mint until goes healthy", async () => {

      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.be.revertedWithCustomError(vaultHub, "InsufficientTotalValueToMint")
        .withArgs(await stakingVault.getAddress(), ether("1") + TEST_STETH_AMOUNT_WEI); // here + testSharesAmountWei is from the report

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
