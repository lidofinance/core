import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { impersonate, randomAddress } from "lib";
import { createVaultWithDashboard, getProtocolContext, ProtocolContext, setupLidoForVaults } from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

describe("Integration: Triggerable Withdrawals", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stakingVault: StakingVault;

  let vaultHub: VaultHub;
  let dashboard: Dashboard;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    const dashboardSigner = await impersonate(dashboard, ether("10000"));

    vaultHub = ctx.contracts.vaultHub.connect(dashboardSigner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(snapshot));

  after(async () => await Snapshot.restore(originalSnapshot));

  context("VaultHub", () => {
    let fee: bigint;
    let excess: bigint;

    beforeEach(async () => {
      excess = ether("0.01");
      fee = await stakingVault.calculateValidatorWithdrawalFee(1);
    });

    it("should successfully trigger full withdrawals", async () => {
      const feeCollector = await randomAddress();

      await expect(
        vaultHub.triggerValidatorWithdrawals(stakingVault, SAMPLE_PUBKEY, [0n], feeCollector, { value: fee + excess }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [0n], excess, feeCollector);

      const excessBalance = await ethers.provider.getBalance(feeCollector);
      expect(excessBalance).to.equal(excess);
    });

    it("should successfully trigger partial withdrawals", async () => {
      const feeCollector = await randomAddress();

      await expect(
        vaultHub.triggerValidatorWithdrawals(stakingVault, SAMPLE_PUBKEY, [1n], feeCollector, { value: fee + excess }),
      )
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(SAMPLE_PUBKEY, [1n], excess, feeCollector);

      const excessBalance = await ethers.provider.getBalance(feeCollector);
      expect(excessBalance).to.equal(excess);
    });
  });
});
