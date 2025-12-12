import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { ether, updateBalance } from "lib";
import {
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
} from "lib/protocol";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub.withdrawableValue", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let agentSigner: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [, owner, nodeOperator] = await ethers.getSigners();

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    vaultHub = ctx.contracts.vaultHub;
    dashboard = dashboard.connect(owner);
    agentSigner = await ctx.getSigner("agent");

    await vaultHub.connect(agentSigner).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), agentSigner);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("withdrawableValue when disconnect is pending", () => {
    it("returns 0 even if vault has withdrawable value", async () => {
      const vaultAddress = await stakingVault.getAddress();

      await dashboard.fund({ value: ether("3") });
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const withdrawableBefore = await vaultHub.withdrawableValue(vaultAddress);
      expect(withdrawableBefore).to.be.gt(0n);

      await dashboard.voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(vaultAddress)).to.be.true;

      const withdrawableAfter = await vaultHub.withdrawableValue(vaultAddress);
      expect(withdrawableAfter).to.equal(0n);

      const totalValue = await vaultHub.totalValue(vaultAddress);
      expect(totalValue).to.be.gt(0n);
    });
  });

  describe("withdrawableValue with redemption obligations", () => {
    it("returns 0 when redemption value exceeds available balance", async () => {
      const { lido } = ctx.contracts;

      await dashboard.fund({ value: ether("4") });
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const redemptionValue = ether("2");
      const redemptionShares = await lido.getSharesByPooledEth(redemptionValue);

      await dashboard.mintShares(owner, redemptionShares);
      await vaultHub.connect(agentSigner).setLiabilitySharesTarget(stakingVault, 0n);

      const limitedBalance = ether("1");
      await updateBalance(stakingVault, limitedBalance);

      const record = await vaultHub.vaultRecord(stakingVault);
      const redemptionValueFromRecord = await lido.getPooledEthBySharesRoundUp(record.redemptionShares);
      expect(redemptionValueFromRecord).to.be.greaterThan(limitedBalance);

      const withdrawable = await vaultHub.withdrawableValue(stakingVault);
      expect(withdrawable).to.equal(0n);
    });
  });
});
