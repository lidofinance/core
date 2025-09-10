import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, StakingVault, VaultHub } from "typechain-types";

import { impersonate } from "lib";
import {
  calculateLockedValue,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
} from "lib/protocol";
import { setStakingLimit } from "lib/protocol/helpers";
import { ether } from "lib/units";

import { Snapshot } from "test/suite";

describe("Integration: VaultHub ", () => {
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

  describe("Minting", () => {
    it("You cannot mint StETH over connection deposit", async () => {
      expect(await vaultHub.maxLockableValue(stakingVault)).to.be.equal(await vaultHub.locked(stakingVault));

      await expect(vaultHub.mintShares(stakingVault, owner, ether("0.1")))
        .to.be.revertedWithCustomError(vaultHub, "InsufficientValue")
        .withArgs(
          stakingVault,
          await calculateLockedValue(ctx, stakingVault, { liabilitySharesIncrease: ether("0.1") }),
          await vaultHub.maxLockableValue(stakingVault),
        );
    });

    it("You can mint StETH if you have funded the vault", async () => {
      // reserve < minimalReserve
      await vaultHub.fund(stakingVault, { value: ether("1") });

      await expect(vaultHub.mintShares(stakingVault, owner, ether("0.1")))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(
          stakingVault,
          ether("0.1"),
          await calculateLockedValue(ctx, stakingVault, { liabilitySharesIncrease: ether("0.1") }),
        );

      expect(await vaultHub.locked(stakingVault)).to.be.equal(await calculateLockedValue(ctx, stakingVault));

      // reserve > minimalReserve
      await vaultHub.fund(stakingVault, { value: ether("100") });

      await expect(vaultHub.mintShares(stakingVault, owner, ether("10")))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(
          stakingVault,
          ether("10"),
          await calculateLockedValue(ctx, stakingVault, { liabilitySharesIncrease: ether("10") }),
        );
    });
  });

  describe("Minting vs Staking Limit", () => {
    let maxStakeLimit: bigint;

    beforeEach(async () => {
      const { lido } = ctx.contracts;

      ({ maxStakeLimit } = await lido.getStakeLimitFullInfo());

      await setStakingLimit(ctx, maxStakeLimit, 0n); // to avoid increasing staking limit

      await dashboard.connect(owner).fund({ value: ether("10") });
    });

    it("Minting should decrease staking limit", async () => {
      const { lido } = ctx.contracts;

      const shares = ether("1");

      const stakingLimitBefore = await lido.getCurrentStakeLimit();

      const amountToMint = await lido.getPooledEthByShares(shares);
      await vaultHub.mintShares(stakingVault, owner, shares);

      const stakingLimitInfoAfter = await lido.getCurrentStakeLimit();
      const expectedLimit = stakingLimitBefore - amountToMint;

      expect(stakingLimitInfoAfter).to.equal(expectedLimit);
    });

    it("Burning should increase staking limit", async () => {
      const { lido } = ctx.contracts;

      const shares = ether("1");
      await vaultHub.mintShares(stakingVault, vaultHub, shares);

      const stakingLimitBefore = await lido.getCurrentStakeLimit();

      const amountToBurn = await lido.getPooledEthByShares(shares);
      await vaultHub.burnShares(stakingVault, shares);

      const stakingLimitAfter = await lido.getCurrentStakeLimit();
      const expectedLimit = stakingLimitBefore + amountToBurn;

      expect(stakingLimitAfter).to.equal(expectedLimit > maxStakeLimit ? maxStakeLimit : expectedLimit);
    });

    it("Minting and burning should not change staking limit", async () => {
      const { lido } = ctx.contracts;

      const shares = ether("1");
      const stakingLimitBeforeAll = await lido.getCurrentStakeLimit();

      for (let i = 0n; i < 500n; i++) {
        const stakingLimitBefore = await lido.getCurrentStakeLimit();

        await vaultHub.mintShares(stakingVault, vaultHub, shares + i);
        await vaultHub.burnShares(stakingVault, shares + i);

        const stakingLimitAfter = await lido.getCurrentStakeLimit();
        const expectedLimit = stakingLimitBefore;

        expect(stakingLimitAfter).to.equal(expectedLimit > maxStakeLimit ? maxStakeLimit : expectedLimit);
      }

      const stakingLimitAfterAll = await lido.getCurrentStakeLimit();
      expect(stakingLimitAfterAll).to.equal(stakingLimitBeforeAll);
    });
  });
});
