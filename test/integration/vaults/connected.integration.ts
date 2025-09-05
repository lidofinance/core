import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { advanceChainTime, days, ether, impersonate, randomAddress, TOTAL_BASIS_POINTS } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "ab".repeat(48);
const TEST_STETH_AMOUNT_WEI = 100n;
const CONNECT_DEPOSIT = ether("1");

describe("Integration: Actions with vault connected to VaultHub", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let pauser: HardhatEthersSigner;
  let agent: HardhatEthersSigner;

  let testSharesAmountWei: bigint;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    vaultHub = ctx.contracts.vaultHub;

    [owner, nodeOperator, stranger, pauser] = await ethers.getSigners();

    // Owner can create a vault with an operator as a node operator
    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);

    await dashboard.fund({ value: ether("1") });

    agent = await ctx.getSigner("agent");

    testSharesAmountWei = await ctx.contracts.lido.getSharesByPooledEth(TEST_STETH_AMOUNT_WEI);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  beforeEach(async () => {
    expect(await vaultHub.isReportFresh(stakingVault)).to.equal(true, "Report is fresh after setup");
    expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true, "Vault is healthy after setup");
  });

  it("VaultHub is pausable and resumable", async () => {
    const { lido } = ctx.contracts;

    await vaultHub.connect(agent).grantRole(await vaultHub.PAUSE_ROLE(), pauser);
    await vaultHub.connect(agent).grantRole(await vaultHub.RESUME_ROLE(), pauser);

    expect(await vaultHub.isPaused()).to.equal(false);

    await expect(vaultHub.connect(pauser).pauseFor(100000n)).to.emit(vaultHub, "Paused");
    expect(await vaultHub.isPaused()).to.equal(true);

    // check that minting is paused
    await expect(dashboard.mintStETH(stranger, TEST_STETH_AMOUNT_WEI)).to.be.revertedWithCustomError(
      vaultHub,
      "ResumedExpected",
    );

    await expect(vaultHub.connect(pauser).resume()).to.emit(vaultHub, "Resumed");
    expect(await vaultHub.isPaused()).to.equal(false);

    // check that minting is resumed
    const lockIncrease = await lido.getPooledEthBySharesRoundUp(testSharesAmountWei);
    expect(lockIncrease).to.be.closeTo(TEST_STETH_AMOUNT_WEI, 2n);

    await expect(dashboard.mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
      .to.emit(vaultHub, "MintedSharesOnVault")
      .withArgs(stakingVault, testSharesAmountWei, CONNECT_DEPOSIT + lockIncrease);
  });

  context("stETH minting", () => {
    it("Allows minting stETH", async () => {
      const { lido } = ctx.contracts;
      // add some stETH to the vault to have totalValue
      await dashboard.fund({ value: ether("1") });

      const lockIncrease = await lido.getPooledEthBySharesRoundUp(testSharesAmountWei);
      expect(lockIncrease).to.be.closeTo(TEST_STETH_AMOUNT_WEI, 2n);

      await expect(dashboard.mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(lido, "Transfer")
        .withArgs(ZeroAddress, stranger, await lido.getPooledEthByShares(testSharesAmountWei))
        .to.emit(lido, "TransferShares")
        .withArgs(ZeroAddress, stranger, testSharesAmountWei)
        .to.emit(lido, "ExternalSharesMinted")
        .withArgs(stranger, testSharesAmountWei)
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, CONNECT_DEPOSIT + lockIncrease);
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

      await dashboard.fund({ value: newLimit + ether("2") }); // try to fund to go healthy

      const lockIncrease = await lido.getPooledEthBySharesRoundUp(testSharesAmountWei);
      expect(lockIncrease).to.be.closeTo(TEST_STETH_AMOUNT_WEI, 2n);

      await expect(dashboard.mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, CONNECT_DEPOSIT + lockIncrease);
    });
  });

  context("stETH burning", () => {
    it("Allows burning stETH", async () => {
      const { lido } = ctx.contracts;

      // add some stETH to the vault to have totalValue, mint shares and approve stETH
      await dashboard.fund({ value: ether("1") });
      await dashboard.mintStETH(owner, TEST_STETH_AMOUNT_WEI);
      await lido.connect(owner).approve(dashboard, TEST_STETH_AMOUNT_WEI);

      const stethAmount = await lido.getPooledEthByShares(testSharesAmountWei);

      const tx = await dashboard.burnStETH(TEST_STETH_AMOUNT_WEI);

      const receipt = await tx.wait();
      const transfers = ctx.getEvents(receipt!, "Transfer");
      expect(transfers.filter((t) => t.args?.to == ZeroAddress).length).to.equal(0);

      const transferShares = ctx.getEvents(receipt!, "TransferShares");
      expect(transferShares.filter((t) => t.args?.to == ZeroAddress).length).to.equal(0);

      await expect(tx)
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei)
        .to.emit(lido, "Transfer")
        .withArgs(owner, vaultHub, stethAmount)
        .to.emit(lido, "TransferShares")
        .withArgs(owner, vaultHub, testSharesAmountWei)
        .to.emit(lido, "SharesBurnt")
        .withArgs(vaultHub, stethAmount, stethAmount, testSharesAmountWei);
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

      await expect(dashboard.requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[0], keys.pubkeys[0])
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[1], keys.pubkeys[1]);
    });

    it("Allows trigger validator withdrawal for vault owner", async () => {
      await expect(dashboard.triggerValidatorWithdrawals(SAMPLE_PUBKEY, [ether("1")], owner, { value: 1n }))
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [ether("1")], 0, owner);
    });

    it("Does not allow trigger validator withdrawal for node operator", async () => {
      await expect(
        stakingVault
          .connect(nodeOperator)
          .triggerValidatorWithdrawals(SAMPLE_PUBKEY, [ether("1")], owner, { value: 1n }),
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

      await dashboard.mintStETH(stranger, ether("1"));

      const sharesBurnt = await vaultHub.liabilityShares(stakingVault);
      const etherToRebalance = await lido.getPooledEthBySharesRoundUp(sharesBurnt);

      await expect(dashboard.rebalanceVaultWithShares(sharesBurnt))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(vaultHub, etherToRebalance)
        .to.emit(vaultHub, "VaultInOutDeltaUpdated")
        .withArgs(stakingVault, ether("2") - etherToRebalance)
        .to.emit(lido, "ExternalEtherTransferredToBuffer")
        .withArgs(etherToRebalance)
        .to.emit(lido, "ExternalSharesBurnt")
        .withArgs(sharesBurnt)
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(stakingVault, sharesBurnt, etherToRebalance);

      expect(await vaultHub.totalValue(stakingVault)).to.equal(ether("2") - etherToRebalance);
    });
  });

  describe("If vault is unhealthy", () => {
    it("Can't mint until goes healthy", async () => {
      const { lido } = ctx.contracts;
      await dashboard.mintStETH(stranger, ether("1"));

      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: TEST_STETH_AMOUNT_WEI }); // slashing
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(false);
      await expect(dashboard.mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.be.revertedWithCustomError(dashboard, "ExceedsMintingCapacity")
        .withArgs(testSharesAmountWei, 0);

      await dashboard.fund({ value: ether("2") });
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.equal(true);

      // calculate the lock increase amount
      const liabilityShares = (await vaultHub.vaultRecord(stakingVault)).liabilityShares + testSharesAmountWei;
      const liability = await lido.getPooledEthBySharesRoundUp(liabilityShares);
      const reserveRatioBP = (await vaultHub.vaultConnection(stakingVault)).reserveRatioBP;

      const reserve = (liability * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - reserveRatioBP) - liability;

      const lock = liability + (reserve > CONNECT_DEPOSIT ? reserve : CONNECT_DEPOSIT);

      await expect(dashboard.mintStETH(stranger, TEST_STETH_AMOUNT_WEI))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, testSharesAmountWei, lock);
    });
  });

  describe("If vault wants to disconnect", () => {
    it("Can't disconnect if report is not fresh", async () => {
      await advanceChainTime(days(2n));
      await expect(dashboard.voluntaryDisconnect())
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(stakingVault);
    });

    it("Can disconnect if report is fresh", async () => {
      await reportVaultDataWithProof(ctx, stakingVault, { totalValue: TEST_STETH_AMOUNT_WEI });
      await expect(dashboard.voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVault);
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
      await advanceChainTime(days(1n));
      await expect(reportVaultDataWithProof(ctx, stakingVault, { totalValue: TEST_STETH_AMOUNT_WEI }))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
    });
  });
});
