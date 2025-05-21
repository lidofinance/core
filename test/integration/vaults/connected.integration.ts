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
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

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

  let snapshot: string;
  let originalSnapshot: string;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

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
    await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n)).to.be.revertedWithCustomError(
      vaultHub,
      "ResumedExpected",
    );

    await expect(vaultHub.connect(pauser).resume()).to.emit(vaultHub, "Resumed");
    expect(await vaultHub.isPaused()).to.equal(false);

    // check that minting is resumed
    await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(stakingVault, 1n);
  });

  context("stETH minting", () => {
    it("Allows minting stETH", async () => {
      // add some stETH to the vault to have totalValue
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, 1n);
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
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });
  });

  context("stETH burning", () => {
    it("Allows burning stETH", async () => {
      const { lido } = ctx.contracts;

      // add some stETH to the vault to have totalValue, mint shares and approve stETH
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      await dashboard.connect(roles.minter).mintStETH(roles.burner, 1n);
      await lido.connect(roles.burner).approve(dashboard, 1n);

      await expect(dashboard.connect(roles.burner).burnStETH(1n))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });

    // Can burn steth from the lido v2 core protocol
    // 1. Mint some stETH
    // 2. transfer stETH to some other address
    // 3. try to burn stETH, get reject that nothing to burn
    // 4. submit some eth to lido (v2 core protocol) lido.submit(sender, { value: amount })
    // 5. try to burn stETH again, now it should work
  });

  context("validator withdrawal", () => {
    it("Vault owner can request validator(s) exit", async () => {
      const keys = getPubkeys(2);
      await expect(dashboard.connect(roles.validatorExitRequester).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(dashboard, keys.pubkeys[0], keys.pubkeys[0])
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(dashboard, keys.pubkeys[1], keys.pubkeys[1]);
    });

    it("Allows trigger validator withdrawal", async () => {
      await expect(
        dashboard
          .connect(roles.validatorWithdrawalTriggerer)
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalTriggered")
        .withArgs(dashboard, SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, 0);

      await expect(
        stakingVault
          .connect(nodeOperator)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
      ).to.emit(stakingVault, "ValidatorWithdrawalTriggered");
    });
  });

  context("rebalancing", () => {
    it("May rebalance debt to the protocol", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // total value is 2 ether
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));

      await expect(dashboard.connect(roles.rebalancer).rebalanceVault(ether(".5")))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(dashboard, vaultHub, ether(".5"))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(stakingVault, ether(".5"));

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("1.5"));
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
      expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.equal(ether("2.5"));
    });

    it("Can't mint more than amount on vault address", async () => {
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, ether("2.6"))).to.be.revertedWithCustomError(
        vaultHub,
        "InsufficientTotalValueToMint",
      );
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, ether("2.1")))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, ether("2.1"));

      expect(await vaultHub.locked(stakingVault)).to.equal(ether("2.1"));

      // providing fresh report
      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2"));
      expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.equal(ether("2.5"));

      await expect(dashboard.connect(roles.minter).mintStETH(stranger, ether("2.1"))).to.be.revertedWithCustomError(
        vaultHub,
        "InsufficientTotalValueToMint",
      );
    });

    it.skip("Withdraw", async () => {
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, ether("1.5")))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, ether("1.5"));

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, ether("1.3"))).to.be.revertedWithCustomError(
        stakingVault,
        "InsufficientUnlocked",
      );
    });

    // todo: add later
    it.skip("Can't triggerValidatorWithdrawal", () => {});

    it("can't mintShares", async () => {
      await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n)).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });
  });

  // skipping for now, going to update these tests later
  describe("If vault is unhealthy", () => {
    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // total value is 2 ether
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1")); // mint 1 ether

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: 1n }); // slashing to 1 wei

      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(false);
    });

    it("Can't mint", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // try to fund to increase the total value (optional)
      // Here now minted 1 stETH, total vault value is 1 wei, so any minting should fail
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.be.revertedWithCustomError(ctx.contracts.vaultHub, "InsufficientTotalValueToMint")
        .withArgs(await stakingVault.getAddress(), ether("1") + 1n); // here + 1n is from the report
    });

    it("Can mint if goes to healthy", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("2") }); // try to fund to go healthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true); // <-- should be healthy now, but the function name is weird

      // Here now minted 1 stETH, total vault value is 1 wei, so any minting should fail
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.be.revertedWithCustomError(ctx.contracts.vaultHub, "InsufficientTotalValueToMint")
        .withArgs(await stakingVault.getAddress(), 1n); // here 1n is total value from report
    });
  });

  describe("Reporting", () => {
    it("updates report data and keep in fresh state for 1 day", async () => {
      await advanceChainTime(days(1n));
      expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true);
    });
  });
});
