import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, Lido, StakingVault, VaultHub } from "typechain-types";

import { BigIntMath, certainAddress, impersonate, TOTAL_BASIS_POINTS } from "lib";
import {
  calculateLockedValue,
  createVaultWithDashboard,
  getProtocolContext,
  ProtocolContext,
  setupLidoForVaults,
} from "lib/protocol";
import { ceilDiv, reportVaultDataWithProof, setStakingLimit } from "lib/protocol/helpers";
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
  let lido: Lido;

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
    lido = ctx.contracts.lido;
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
      ({ maxStakeLimit } = await lido.getStakeLimitFullInfo());

      await setStakingLimit(ctx, maxStakeLimit, 0n); // to avoid increasing staking limit

      await dashboard.connect(owner).fund({ value: ether("10") });
    });

    it("Minting should decrease staking limit", async () => {
      const shares = ether("1");

      const stakingLimitBefore = await lido.getCurrentStakeLimit();

      const amountToMint = await lido.getPooledEthByShares(shares);
      await vaultHub.mintShares(stakingVault, owner, shares);

      const stakingLimitInfoAfter = await lido.getCurrentStakeLimit();
      const expectedLimit = stakingLimitBefore - amountToMint;

      expect(stakingLimitInfoAfter).to.equal(expectedLimit);
    });

    it("Burning should increase staking limit", async () => {
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

  describe("Total Minting Capacity Shares", () => {
    beforeEach(async () => {
      const fundedAmount = ether("10");
      await dashboard.connect(owner).fund({ value: fundedAmount });
    });

    it("returns correct total minting capacity shares", async () => {
      const totalValue = await vaultHub.totalValue(stakingVault);
      const record = await vaultHub.vaultRecord(stakingVault);
      const connection = await vaultHub.vaultConnection(stakingVault);
      const reserve = ceilDiv(totalValue * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
      const capacity = totalValue - BigIntMath.max(reserve, record.minimalReserve);

      const expectedMintingCapacityShares = await lido.getSharesByPooledEth(capacity);

      expect(await vaultHub.totalMintingCapacityShares(stakingVault, 0)).to.equal(expectedMintingCapacityShares);
    });

    it("takes unsettled lido fees into account", async () => {
      const fees = ether("1");
      await reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: fees, waitForNextRefSlot: true });

      const record = await vaultHub.vaultRecord(stakingVault);
      const connection = await vaultHub.vaultConnection(stakingVault);

      const totalValue = await vaultHub.totalValue(stakingVault);
      const totalValueMinusFees = totalValue - record.cumulativeLidoFees;
      const reserve = ceilDiv(totalValueMinusFees * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
      const capacity = totalValueMinusFees - BigIntMath.max(reserve, record.minimalReserve);

      const expectedMintingCapacityShares = await lido.getSharesByPooledEth(capacity);

      expect(await vaultHub.totalMintingCapacityShares(stakingVault, 0)).to.equal(expectedMintingCapacityShares);
    });

    it("takes positive delta value into account", async () => {
      const record = await vaultHub.vaultRecord(stakingVault);
      const connection = await vaultHub.vaultConnection(stakingVault);

      const totalValue = await vaultHub.totalValue(stakingVault);
      const deltaValue = ether("1");

      const totalValuePlusDelta = totalValue + deltaValue;
      const reservePlusDelta = ceilDiv(totalValuePlusDelta * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
      const capacityPlusDelta = totalValuePlusDelta - BigIntMath.max(reservePlusDelta, record.minimalReserve);
      const expectedMintingCapacitySharesPlusDelta = await lido.getSharesByPooledEth(capacityPlusDelta);

      expect(await vaultHub.totalMintingCapacityShares(stakingVault, deltaValue)).to.equal(
        expectedMintingCapacitySharesPlusDelta,
      );
    });

    it("takes negative delta value into account", async () => {
      const record = await vaultHub.vaultRecord(stakingVault);
      const connection = await vaultHub.vaultConnection(stakingVault);

      const totalValue = await vaultHub.totalValue(stakingVault);
      const deltaValue = -ether("1");

      const totalValueMinusDelta = totalValue - ether("1");
      const reserveMinusDelta = ceilDiv(totalValueMinusDelta * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
      const capacityMinusDelta = totalValueMinusDelta - BigIntMath.max(reserveMinusDelta, record.minimalReserve);
      const expectedMintingCapacitySharesMinusDelta = await lido.getSharesByPooledEth(capacityMinusDelta);

      expect(await vaultHub.totalMintingCapacityShares(stakingVault, deltaValue)).to.equal(
        expectedMintingCapacitySharesMinusDelta,
      );
    });

    it("handles zero delta value", async () => {
      const withoutDelta = await vaultHub.totalMintingCapacityShares(stakingVault, 0);
      const withZeroDelta = await vaultHub.totalMintingCapacityShares(stakingVault, 0);

      expect(withZeroDelta).to.equal(withoutDelta);
    });

    it("returns 0 when negative delta exceeds total value", async () => {
      const totalValue = await vaultHub.totalValue(stakingVault);
      const deltaValue = -(totalValue + ether("1"));

      expect(await vaultHub.totalMintingCapacityShares(stakingVault, deltaValue)).to.equal(0n);
    });

    for (const deltaValue of [1n, 2n, 3n, 5n, 10n, 100n, 1000n, ether("1"), ether("10")]) {
      it(`handles ${ethers.formatEther(deltaValue)} deltas`, async () => {
        const totalValue = await vaultHub.totalValue(stakingVault);
        const record = await vaultHub.vaultRecord(stakingVault);
        const connection = await vaultHub.vaultConnection(stakingVault);

        // Plus delta
        const plus = totalValue + deltaValue;
        const reservePlus = ceilDiv(plus * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
        const capPlus = plus - BigIntMath.max(reservePlus, record.minimalReserve);
        const expSharesPlus = await lido.getSharesByPooledEth(capPlus);

        expect(await vaultHub.totalMintingCapacityShares(stakingVault, deltaValue)).to.equal(expSharesPlus);

        // Minus delta
        const minus = totalValue - deltaValue;
        const reserveMinus = ceilDiv(minus * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
        const capMinus = minus - BigIntMath.max(reserveMinus, record.minimalReserve);
        const expSharesMinus = await lido.getSharesByPooledEth(capMinus);

        expect(await vaultHub.totalMintingCapacityShares(stakingVault, -deltaValue)).to.equal(expSharesMinus);
      });
    }

    it("handles fees > totalValue with positive delta recovery", async () => {
      // Report fees higher than current total value 11 ETH
      const highFees = ether("12");
      await reportVaultDataWithProof(ctx, stakingVault, { cumulativeLidoFees: highFees, waitForNextRefSlot: true });

      const totalValue = await vaultHub.totalValue(stakingVault);

      // Without delta, capacity should be 0
      expect(await vaultHub.totalMintingCapacityShares(stakingVault, 0)).to.equal(0n);

      // With large enough delta, should recover
      const recoveryDelta = ether("5");
      const record = await vaultHub.vaultRecord(stakingVault);
      const connection = await vaultHub.vaultConnection(stakingVault);

      const maxLockableValue = totalValue + recoveryDelta - record.cumulativeLidoFees;

      const reserve = ceilDiv(maxLockableValue * connection.reserveRatioBP, TOTAL_BASIS_POINTS);
      const capacity = maxLockableValue - BigIntMath.max(reserve, record.minimalReserve);
      const expectedShares = await lido.getSharesByPooledEth(capacity);

      expect(await vaultHub.totalMintingCapacityShares(stakingVault, recoveryDelta)).to.equal(expectedShares);
    });

    it("handles negative delta causing underflow in reserve calculation", async () => {
      const totalValue = await vaultHub.totalValue(stakingVault);
      const deltaValue = -(totalValue - 1n);

      const result = await vaultHub.totalMintingCapacityShares(stakingVault, deltaValue);
      expect(result).to.equal(0n);
    });

    it("returns 0 for disconnected vault regardless of delta", async () => {
      const disconnectedVault = await certainAddress("disconnected-vault");

      expect(await vaultHub.totalMintingCapacityShares(disconnectedVault, 0)).to.equal(0n);
      expect(await vaultHub.totalMintingCapacityShares(disconnectedVault, ether("10"))).to.equal(0n);
      expect(await vaultHub.totalMintingCapacityShares(disconnectedVault, -ether("5"))).to.equal(0n);
    });
  });
});
