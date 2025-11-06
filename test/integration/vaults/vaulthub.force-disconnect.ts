import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { BigIntMath, days } from "lib";
import {
  changeTier,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  setUpOperatorGrid,
} from "lib/protocol";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub Force Disconnect", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let agentSigner: HardhatEthersSigner;
  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let vaultMaster: HardhatEthersSigner;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;
  let vaultHub: VaultHub;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);
    [, owner, nodeOperator, vaultMaster] = await ethers.getSigners();

    await setUpOperatorGrid(ctx, [nodeOperator]);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    dashboard = dashboard.connect(owner);
    vaultHub = ctx.contracts.vaultHub;

    await changeTier(ctx, dashboard, owner, nodeOperator);

    // Grant VAULT_MASTER_ROLE to vaultMaster
    await vaultHub.connect(await ctx.getSigner("agent")).grantRole(await vaultHub.VAULT_MASTER_ROLE(), vaultMaster);

    agentSigner = await ctx.getSigner("agent");

    // set maximum fee rate per second to 1 ether to allow rapid fee increases
    await ctx.contracts.lazyOracle.connect(agentSigner).updateSanityParams(days(30n), 1000n, 1000000000000000000n);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("VAULT_MASTER_ROLE can force disconnect", () => {
    for (const feePercent of [50n, 100n, 150n]) {
      it(`disconnects when fee is ${feePercent}% of the vault balance`, async () => {
        const vaultBalance = await ethers.provider.getBalance(stakingVault);
        const feesToSettle = (vaultBalance * feePercent) / 100n;

        // Setup: Connected vault with liabilityShares = 0, fresh report, unsettled fees < balance
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("1"),
          cumulativeLidoFees: feesToSettle, // Create some unsettled fees
        });

        // Verify initial state
        expect(await vaultHub.liabilityShares(stakingVault)).to.equal(0n);
        expect(await vaultHub.isReportFresh(stakingVault)).to.be.true;
        const unsettledFees = await vaultHub.obligations(stakingVault);
        expect(unsettledFees.feesToSettle).to.be.equal(feesToSettle);

        const treasuryBalanceBefore = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());

        // Action: VAULT_MASTER_ROLE calls disconnect(vault)
        const tx = await vaultHub.connect(vaultMaster).disconnect(stakingVault);
        await expect(tx).to.emit(vaultHub, "VaultDisconnectInitiated").withArgs(stakingVault);

        // Expected: disconnectInitiatedTs = block.timestamp
        const receipt = await tx.wait();
        const blockTimestamp = (await ethers.provider.getBlock(receipt!.blockNumber))?.timestamp || 0n;
        const connection = await vaultHub.vaultConnection(stakingVault);
        expect(connection.disconnectInitiatedTs).to.equal(BigInt(blockTimestamp));

        const settleAmount = BigIntMath.min(vaultBalance, feesToSettle);
        const treasuryAfter = await ethers.provider.getBalance(await ctx.contracts.locator.treasury());
        expect(treasuryAfter).to.be.equal(treasuryBalanceBefore + settleAmount);
        expect(await ethers.provider.getBalance(await stakingVault.getAddress())).to.be.equal(
          vaultBalance - settleAmount,
        );

        // Verify vault is pending disconnect
        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

        await expect(
          reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1"), cumulativeLidoFees: feesToSettle }),
        )
          .to.emit(vaultHub, "VaultDisconnectCompleted")
          .withArgs(stakingVault);

        // Expected: vault is disconnected
        expect((await ctx.contracts.operatorGrid.vaultTierInfo(stakingVault)).tierId).to.be.equal(0n);
        expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.false;
        expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;
        expect(await vaultHub.locked(stakingVault)).to.be.equal(0n);
      });
    }
  });
});
