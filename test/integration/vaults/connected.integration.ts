import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { advanceChainTime, ether, getCurrentBlockTimestamp, impersonate, randomAddress } from "lib";
import {
  createVaultWithDashboard,
  disconnectFromHub,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLido,
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
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await vaultHub.isVaultHealthyAsOfLatestReport(stakingVault)).to.equal(true);
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
    // 4. submit some ethe to lido (v2 core protocol) lido.submit(sender, { value: amount })
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
          .triggerValidatorWithdrawal(SAMPLE_PUBKEY, [ether("1")], roles.validatorWithdrawalTriggerer, { value: 1n }),
      ).to.emit(stakingVault, "ValidatorWithdrawalTriggered");
    });
  });

  context("rebalancing", () => {
    it("May rebalance debt to the protocol", async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // total value is 2 ether
      await dashboard.connect(roles.locker).lock(ether("2")); // raise cap full capacity
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1"));

      await expect(dashboard.connect(roles.rebalancer).rebalanceVault(ether(".5")))
        .to.emit(stakingVault, "Withdrawn")
        .withArgs(dashboard, vaultHub, ether(".5"))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(stakingVault, ether(".5"));

      expect(await stakingVault.totalValue()).to.equal(ether("1.5"));
    });
  });

  describe("Outdated report", () => {
    beforeEach(async () => {
      await reportVaultDataWithProof(stakingVault);
      await advanceChainTime((await vaultHub.REPORT_FRESHNESS_DELTA()) + 100n);
      await dashboard.connect(roles.funder).fund({ value: ether("1") });

      const maxStakeLimit = ether("0.5");
      const sender = await impersonate(randomAddress(), maxStakeLimit + ether("1"));
      await sender.sendTransaction({
        to: await stakingVault.getAddress(),
        value: maxStakeLimit,
      });

      expect(await stakingVault.isReportFresh()).to.equal(false);
      expect(await stakingVault.totalValue()).to.equal(ether("2"));
      expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.equal(ether("2.5"));
    });

    it("Can't lock more than amount on vault address", async () => {
      await expect(dashboard.connect(roles.locker).lock(ether("2.6"))).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedExceedsTotalValue",
      );
      await expect(dashboard.connect(roles.locker).lock(ether("2.1")))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(ether("2.1"));

      expect(await stakingVault.locked()).to.equal(ether("2.1"));

      // providing fresh report
      await reportVaultDataWithProof(stakingVault);
      expect(await stakingVault.isReportFresh()).to.equal(true);
      expect(await stakingVault.totalValue()).to.equal(ether("2"));
      expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.equal(ether("2.5"));

      await expect(dashboard.connect(roles.locker).lock(ether("2.1"))).to.be.revertedWithCustomError(
        stakingVault,
        "NewLockedExceedsTotalValue",
      );
    });

    // todo: add later
    it.skip("Withdraw", async () => {
      await expect(dashboard.connect(roles.locker).lock(ether("1.5")))
        .to.emit(stakingVault, "LockedIncreased")
        .withArgs(ether("2.1"));

      await expect(dashboard.connect(roles.locker).withdraw(stranger, ether("1.3"))).to.be.revertedWithCustomError(
        stakingVault,
        "TotalValueBelowLockedAmount",
      );
    });

    // todo: add later
    it.skip("Can't triggerValidatorWithdrawal", () => {});

    it("can't mintShares", async () => {
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n)).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStaled",
      );
      await reportVaultDataWithProof(stakingVault);

      expect(await stakingVault.isReportFresh()).to.equal(true);
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, 1n);
    });
  });

  // skipping for now, going to update these tests later
  describe.skip("If vault is unhealthy", () => {
    beforeEach(async () => {
      await dashboard.connect(roles.funder).fund({ value: ether("1") }); // total value is 2 ether
      await dashboard.connect(roles.locker).lock(ether("2")); // raise cap full capacity
      await dashboard.connect(roles.minter).mintStETH(stranger, ether("1")); // mint 1 ether

      const vaultHubSigner = await impersonate(await vaultHub.getAddress(), ether("100"));
      await stakingVault.connect(vaultHubSigner).report(await getCurrentBlockTimestamp(), 1n, ether("2"), ether("2")); // below the threshold

      expect(await vaultHub.isVaultHealthyAsOfLatestReport(stakingVault)).to.equal(false);
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
      expect(await vaultHub.isVaultHealthyAsOfLatestReport(stakingVault)).to.equal(true); // <-- should be healthy now, but the function name is weird

      // Here now minted 1 stETH, total vault value is 1 wei, so any minting should fail
      await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
        .to.be.revertedWithCustomError(ctx.contracts.vaultHub, "InsufficientTotalValueToMint")
        .withArgs(await stakingVault.getAddress(), 1n); // here 1n is total value from report
    });
  });

  describe("Authorize / Deauthorize Lido VaultHub", () => {
    it("After creation via createVaultWithDelegation and connection vault is authorized", async () => {
      expect(await stakingVault.vaultHubAuthorized()).to.equal(true);
    });

    it("Can't deauthorize Lido VaultHub if connected to Hub", async () => {
      await expect(
        dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub(),
      ).to.be.revertedWithCustomError(stakingVault, "VaultConnected");
    });

    it("Can deauthorize Lido VaultHub if dicsconnected from Hub", async () => {
      await disconnectFromHub(ctx, stakingVault);
      await reportVaultDataWithProof(stakingVault);

      await expect(dashboard.connect(roles.lidoVaultHubDeauthorizer).deauthorizeLidoVaultHub())
        .to.emit(stakingVault, "VaultHubAuthorizedSet")
        .withArgs(false);
    });
  });
});
