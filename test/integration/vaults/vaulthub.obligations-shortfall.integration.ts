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

describe("Integration: VaultHub.obligationsShortfallValue", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let vaultHub: VaultHub;
  let stakingVault: StakingVault;
  let dashboard: Dashboard;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let dao: HardhatEthersSigner;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    await setupLidoForVaults(ctx);

    [, owner, nodeOperator, dao] = await ethers.getSigners();

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
    ));

    vaultHub = ctx.contracts.vaultHub;
    dashboard = dashboard.connect(owner);

    const agentSigner = await ctx.getSigner("agent");
    await vaultHub.connect(agentSigner).grantRole(await vaultHub.VAULT_MASTER_ROLE(), dao);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  describe("obligationsShortfallValue when connection is removed", () => {
    it("returns 0 after disconnect even if shortfall existed", async () => {
      await dashboard.fund({ value: ether("3") });
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      await updateBalance(stakingVault, 0n);
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("1"),
        cumulativeLidoFees: ether("2"),
        waitForNextRefSlot: true,
      });

      const shortfallBefore = await vaultHub.obligationsShortfallValue(stakingVault);
      expect(shortfallBefore).to.equal(ether("2"));

      await expect(vaultHub.connect(dao).disconnect(stakingVault))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVault);

      await expect(
        reportVaultDataWithProof(ctx, stakingVault, { totalValue: ether("1"), cumulativeLidoFees: ether("2") }),
      )
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      const shortfallAfter = await vaultHub.obligationsShortfallValue(stakingVault);
      expect(shortfallAfter).to.equal(0n);
    });
  });
});
