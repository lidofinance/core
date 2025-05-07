import { expect } from "chai";
import { ethers } from "hardhat";
import { beforeEach } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { advanceChainTime, generateValidator, getCurrentBlockTimestamp, impersonate, randomAddress } from "lib";
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
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

import { getProofAndDepositData } from "../../../lib/protocol/helpers/vaults";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);

describe("Integration: Actions with vault is connected to VaultHub", () => {
  let ctx: ProtocolContext;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let roles: VaultRoles;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  let snapshot: string;
  let originalSnapshot: string;
  let vaultHub: VaultHub;

  before(async () => {
    ctx = await getProtocolContext();

    originalSnapshot = await Snapshot.take();

    await setupLido(ctx);

    [owner, nodeOperator, stranger] = await ethers.getSigners();

    // Owner can create a vault with operator as a node operator
    ({ stakingVault, dashboard, roles } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
      [],
    ));
    ({ vaultHub } = ctx.contracts);
    agent = await ctx.getSigner("agent");
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await vaultHub.isVaultHealthyAsOfLatestReport(stakingVault)).to.equal(true);
  });

  it("Vault is pausable and resumable", async () => {
    const pdg = ctx.contracts.predepositGuarantee.connect(agent);

    await pdg.grantRole(await vaultHub.PAUSE_ROLE(), stranger);
    await pdg.grantRole(await vaultHub.RESUME_ROLE(), stranger);

    expect(await pdg.isPaused()).to.equal(false);
    await expect(pdg.connect(stranger).pauseFor(10n)).to.emit(pdg, "Paused");
    expect(await pdg.isPaused()).to.equal(true);
    await expect(pdg.connect(stranger).resume()).to.emit(pdg, "Resumed");
    expect(await pdg.isPaused()).to.equal(false);
  });

  it("Can not deposit if paused", async () => {
    const { predepositGuarantee } = ctx.contracts;

    const pdg = predepositGuarantee.connect(agent);

    await predepositGuarantee.connect(agent).grantRole(await vaultHub.PAUSE_ROLE(), stranger);
    await predepositGuarantee.connect(stranger).pauseFor(10n);

    const withdrawalCredentials = await stakingVault.withdrawalCredentials();
    const validator = generateValidator(withdrawalCredentials);

    const { witnesses, postdeposit } = await getProofAndDepositData(
      predepositGuarantee,
      validator,
      withdrawalCredentials,
    );

    await expect(
      predepositGuarantee.connect(nodeOperator).proveAndDeposit(witnesses, [postdeposit], stakingVault),
    ).to.be.revertedWithCustomError(pdg, "ResumedExpected");
  });

  it("Allows minting stETH", async () => {
    // add some stETH to the vault to have totalValue
    await dashboard.connect(roles.funder).fund({ value: ether("1") });

    await expect(dashboard.connect(roles.minter).mintStETH(stranger, 1n))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(stakingVault, 1n);
  });

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

  it("Vault owner can request validator(s) exit", async () => {
    const keys = getPubkeys(2);
    await expect(dashboard.connect(roles.validatorExitRequester).requestValidatorExit(keys.stringified))
      .to.emit(stakingVault, "ValidatorExitRequested")
      .withArgs(dashboard, keys.pubkeys[0], keys.pubkeys[0])
      .to.emit(stakingVault, "ValidatorExitRequested")
      .withArgs(dashboard, keys.pubkeys[1], keys.pubkeys[1]);
  });

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

  it.skip("Can mint stETH over v2 limit", async () => {
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

  describe("With old report", () => {
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
