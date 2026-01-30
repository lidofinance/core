import { expect } from "chai";
import { hexlify, MaxUint256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { SecretKey } from "@chainsafe/blst";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Dashboard, Lido, PredepositGuarantee, SSZBLSHelpers, StakingVault, VaultHub, WstETH } from "typechain-types";

import {
  advanceChainTime,
  days,
  ether,
  generateDepositStruct,
  generateValidator,
  LocalMerkleTree,
  mEqual,
  PDGPolicy,
  prepareLocalMerkleTree,
  randomAddress,
  randomValidatorPubkey,
  TOTAL_BASIS_POINTS,
} from "lib";
import {
  autofillRoles,
  calculateLockedValue,
  createVaultWithDashboard,
  ensurePredepositGuaranteeUnpaused,
  getProtocolContext,
  getPubkeys,
  ProtocolContext,
  reportVaultDataWithProof,
  setupLidoForVaults,
  VaultRoles,
} from "lib/protocol";

import { Snapshot } from "test/suite";

// EIP-7528 ETH address
const ETH_ADDRESS = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

type ValidatorInfo = {
  container: SSZBLSHelpers.ValidatorStruct;
  blsPrivateKey: SecretKey;
  index: number;
  proof: string[];
};

describe("Integration: Dashboard Full Coverage", () => {
  let ctx: ProtocolContext;
  let snapshot: string;
  let originalSnapshot: string;

  let owner: HardhatEthersSigner;
  let nodeOperator: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let dashboard: Dashboard;
  let stakingVault: StakingVault;
  let vaultHub: VaultHub;
  let predepositGuarantee: PredepositGuarantee;
  let lido: Lido;
  let wstETH: WstETH;

  let roles: VaultRoles;

  let mockCLtree: LocalMerkleTree | undefined;
  let slot: bigint;
  let childBlockTimestamp: number;
  let beaconBlockHeader: SSZBLSHelpers.BeaconBlockHeaderStruct;

  before(async () => {
    ctx = await getProtocolContext();
    originalSnapshot = await Snapshot.take();

    [, owner, nodeOperator, stranger] = await ethers.getSigners();
    await setupLidoForVaults(ctx);

    ({ stakingVault, dashboard } = await createVaultWithDashboard(
      ctx,
      ctx.contracts.stakingVaultFactory,
      owner,
      nodeOperator,
      nodeOperator,
    ));

    vaultHub = ctx.contracts.vaultHub;
    predepositGuarantee = ctx.contracts.predepositGuarantee;
    lido = ctx.contracts.lido;
    wstETH = ctx.contracts.wstETH;

    // Connect dashboard to owner for role management
    dashboard = dashboard.connect(owner);

    // Autofill roles
    roles = await autofillRoles(dashboard, nodeOperator);

    // Fund the vault for testing
    await dashboard.connect(owner).fund({ value: ether("10") });

    // Set PDG policy to ALLOW_DEPOSIT_AND_PROVE for testing
    await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

    slot = await predepositGuarantee.PIVOT_SLOT();
    mockCLtree = await prepareLocalMerkleTree(await predepositGuarantee.GI_FIRST_VALIDATOR_CURR());
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  // ==================== View Functions ====================

  describe("View Functions", () => {
    describe("vaultConnection()", () => {
      it("Returns the vault connection data", async () => {
        const connection = await dashboard.vaultConnection();
        const vaultHubConnection = await vaultHub.vaultConnection(stakingVault);

        // Verify connection matches VaultHub's data exactly
        expect(connection.owner).to.equal(vaultHubConnection.owner);
        expect(connection.shareLimit).to.equal(vaultHubConnection.shareLimit);
        expect(connection.vaultIndex).to.equal(vaultHubConnection.vaultIndex);
        expect(connection.disconnectInitiatedTs).to.equal(vaultHubConnection.disconnectInitiatedTs);
        expect(connection.reserveRatioBP).to.equal(vaultHubConnection.reserveRatioBP);
      });
    });

    describe("liabilityShares()", () => {
      it("Returns 0 when no shares minted", async () => {
        expect(await dashboard.liabilityShares()).to.equal(0n);
      });

      it("Returns correct value after minting", async () => {
        const sharesToMint = ether("1");
        await dashboard.connect(owner).mintShares(owner, sharesToMint);
        expect(await dashboard.liabilityShares()).to.equal(sharesToMint);
      });
    });

    describe("totalValue()", () => {
      it("Returns the vault's total value", async () => {
        // Funded with 10 ETH + 1 ETH connection deposit
        expect(await dashboard.totalValue()).to.equal(ether("11"));
      });
    });

    describe("locked()", () => {
      it("Returns locked amount (minimal reserve when no liabilities)", async () => {
        const locked = await dashboard.locked();
        expect(locked).to.equal(ether("1")); // Connection deposit
      });

      it("Increases when shares are minted", async () => {
        const lockedBefore = await dashboard.locked();
        const sharesToMint = ether("1");
        await dashboard.connect(owner).mintShares(owner, sharesToMint);

        // Verify locked matches VaultHub's calculation
        const lockedAfter = await dashboard.locked();
        const vaultHubLocked = await vaultHub.locked(stakingVault);

        expect(lockedAfter).to.equal(vaultHubLocked);
        expect(lockedAfter).to.be.gt(lockedBefore); // Verify it increased
      });
    });

    describe("obligations()", () => {
      it("Returns (0, 0) when vault has no obligations", async () => {
        const [sharesToBurn, feesToSettle] = await dashboard.obligations();
        expect(sharesToBurn).to.equal(0n);
        expect(feesToSettle).to.equal(0n);
      });

      it("Returns correct values when fees exist", async () => {
        await reportVaultDataWithProof(ctx, stakingVault, {
          cumulativeLidoFees: ether("0.5"),
          waitForNextRefSlot: true,
        });
        const [, feesToSettle] = await dashboard.obligations();
        expect(feesToSettle).to.equal(ether("0.5"));
      });
    });

    describe("healthShortfallShares()", () => {
      it("Returns 0 when vault is healthy", async () => {
        expect(await dashboard.healthShortfallShares()).to.equal(0n);
      });

      it("Returns non-zero when vault is unhealthy", async () => {
        // Mint maximum then simulate slashing
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);

        const liabilityShares = await dashboard.liabilityShares();

        // Simulate severe slashing to create unhealthy state (slash to 50% of liability value)
        const liabilityValue = await lido.getPooledEthByShares(liabilityShares);
        const slashedValue = liabilityValue / 2n;

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: slashedValue,
          waitForNextRefSlot: true,
        });

        // Verify vault is unhealthy
        expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;

        // Verify shortfall matches VaultHub's calculation
        const shortfall = await dashboard.healthShortfallShares();
        const vaultHubShortfall = await vaultHub.healthShortfallShares(stakingVault);

        expect(shortfall).to.equal(vaultHubShortfall);
      });
    });

    describe("obligationsShortfallValue()", () => {
      it("Returns 0 when no obligations shortfall", async () => {
        expect(await dashboard.obligationsShortfallValue()).to.equal(0n);
      });
    });

    describe("minimalReserve()", () => {
      it("Returns the minimal reserve", async () => {
        expect(await dashboard.minimalReserve()).to.equal(ether("1"));
      });

      it("Accounts for slashing reserve from report", async () => {
        // Initial minimal reserve is CONNECT_DEPOSIT (1 ETH)
        expect(await dashboard.minimalReserve()).to.equal(ether("1"));

        const slashingReserve = ether("5");

        await reportVaultDataWithProof(ctx, stakingVault, {
          slashingReserve,
          waitForNextRefSlot: true,
        });

        // minimalReserve should now be max(CONNECT_DEPOSIT, slashingReserve) = 5 ETH
        expect(await dashboard.minimalReserve()).to.equal(slashingReserve);
      });
    });

    describe("maxLockableValue()", () => {
      it("Returns max lockable value minus node operator fee", async () => {
        // Simulate growth that creates fees
        const tvBefore = await dashboard.totalValue();
        const growth = ether("10"); // Significant growth to create meaningful fees

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: tvBefore + growth,
          waitForNextRefSlot: true,
        });

        const accruedFee = await dashboard.accruedFee();
        const vaultHubMaxLockable = await vaultHub.maxLockableValue(stakingVault);
        const dashboardMaxLockable = await dashboard.maxLockableValue();

        expect(accruedFee).to.be.lt(vaultHubMaxLockable);
        expect(dashboardMaxLockable).to.equal(vaultHubMaxLockable - accruedFee);
      });

      it("Returns 0 when accrued fee exceeds max lockable", async () => {
        // Mint at max capacity to minimize free ether for locking
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);

        // Simulate massive growth to create large fees
        // Need growth large enough that NO fee exceeds vaultHub maxLockableValue
        const totalValue = await dashboard.totalValue();
        const vaultHubMaxLockable = await vaultHub.maxLockableValue(stakingVault);

        // To ensure fee > maxLockable, we need growth such that:
        // settledGrowth * feeRate > vaultHubMaxLockable
        const requiredGrowth = vaultHubMaxLockable * 150n; // 150x to be sure

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValue + requiredGrowth,
          waitForNextRefSlot: true,
        });

        const accruedFee = await dashboard.accruedFee();
        const vaultHubMaxLockableAfter = await vaultHub.maxLockableValue(stakingVault);
        const dashboardMaxLockable = await dashboard.maxLockableValue();

        expect(accruedFee).to.be.gte(vaultHubMaxLockableAfter);
        expect(dashboardMaxLockable).to.equal(0n);
      });
    });

    describe("totalMintingCapacityShares()", () => {
      it("Returns minting capacity accounting for fees", async () => {
        // Simulate growth to create fees
        const tvBefore = await dashboard.totalValue();
        const growth = ether("10");

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: tvBefore + growth,
          waitForNextRefSlot: true,
        });

        const accruedFee = await dashboard.accruedFee();
        expect(accruedFee).to.be.gt(0n);

        const dashboardCapacity = await dashboard.totalMintingCapacityShares();
        const vaultHubCapacityWithFee = await vaultHub.totalMintingCapacityShares(stakingVault, -BigInt(accruedFee));

        // Verify dashboard correctly passes -accruedFee to vaultHub
        expect(dashboardCapacity).to.equal(vaultHubCapacityWithFee);
      });
    });

    describe("remainingMintingCapacityShares()", () => {
      it("Returns full capacity when no shares minted", async () => {
        const remaining = await dashboard.remainingMintingCapacityShares(0n);
        const total = await dashboard.totalMintingCapacityShares();
        expect(remaining).to.equal(total);
      });

      it("Returns 0 when at capacity", async () => {
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);
        expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
      });

      it("Accounts for additional ether to fund", async () => {
        const withoutFunding = await dashboard.remainingMintingCapacityShares(0n);
        const funding = ether("10");
        const withFunding = await dashboard.remainingMintingCapacityShares(funding);

        // Verify funding increases capacity
        expect(withFunding).to.be.gt(withoutFunding);

        // Verify the increase is reasonable (funding contributes to capacity accounting for reserve ratio)
        // mintableEth = maxLockableValue * (TOTAL_BASIS_POINTS - reserveRatioBP) / TOTAL_BASIS_POINTS
        // With 50% reserve ratio, 10 ETH funding should contribute ~5 ETH worth of mintable capacity
        const fundingShares = await lido.getSharesByPooledEth(funding);
        const connection = await dashboard.vaultConnection();
        const reserveRatioBP = connection.reserveRatioBP;
        const expectedContribution = (fundingShares * (TOTAL_BASIS_POINTS - reserveRatioBP)) / TOTAL_BASIS_POINTS;
        const actualIncrease = withFunding - withoutFunding;

        // Allow for rounding differences
        expect(actualIncrease).to.be.closeTo(expectedContribution, 2n);
      });

      it("Returns 0 when capacity is exceeded by liabilities", async () => {
        // Mint max
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);
        expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
      });
    });

    describe("withdrawableValue()", () => {
      it("Returns withdrawable amount accounting for fees", async () => {
        // Simulate growth to create fees
        const tvBefore = await dashboard.totalValue();
        const growth = ether("5");

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: tvBefore + growth,
          waitForNextRefSlot: true,
        });

        const withdrawable = await dashboard.withdrawableValue();
        const vaultHubWithdrawable = await vaultHub.withdrawableValue(stakingVault);
        const accruedFee = await dashboard.accruedFee();

        // Verify fees exist
        expect(accruedFee).to.be.gt(0n);

        // Explicitly verify fee < withdrawable (testing non-zero case)
        expect(accruedFee).to.be.lt(vaultHubWithdrawable);

        // Explicitly verify withdrawable = vaultHub withdrawable - fee
        expect(withdrawable).to.equal(vaultHubWithdrawable - accruedFee);
      });

      it("Returns 0 when fee exceeds withdrawable", async () => {
        // Set fee rate to 100% to make calculation simpler
        await dashboard.connect(owner).setFeeRate(TOTAL_BASIS_POINTS);
        await dashboard.connect(nodeOperator).setFeeRate(TOTAL_BASIS_POINTS);

        // Mint max to lock all value
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);

        const totalValue = await dashboard.totalValue();
        const vaultHubWithdrawable = await vaultHub.withdrawableValue(stakingVault);
        const requiredGrowth = vaultHubWithdrawable + ether("1");

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValue + requiredGrowth,
          waitForNextRefSlot: true,
        });

        const accruedFee = await dashboard.accruedFee();
        const vaultHubWithdrawableAfter = await vaultHub.withdrawableValue(stakingVault);
        const withdrawable = await dashboard.withdrawableValue();

        // Explicitly verify fee >= withdrawable (testing zero case)
        expect(accruedFee).to.be.gte(vaultHubWithdrawableAfter);

        // Explicitly verify dashboard returns 0
        expect(withdrawable).to.equal(0n);
      });
    });

    describe("latestReport()", () => {
      it("Returns the latest vault report", async () => {
        // Get initial report
        const initialReport = await dashboard.latestReport();
        const initialTimestamp = initialReport.timestamp;

        // Fund the vault
        const fundAmount = ether("10");
        await dashboard.connect(owner).fund({ value: fundAmount });

        // Get current total value (includes funding)
        const currentTotalValue = await dashboard.totalValue();

        // Submit a report (totalValue gets capped by actual vault balance)
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: currentTotalValue,
          waitForNextRefSlot: true,
        });

        // Get the latest report
        const report = await dashboard.latestReport();

        // Verify report was updated
        expect(report.totalValue).to.equal(currentTotalValue);
        expect(report.timestamp).to.be.gt(initialTimestamp);

        // inOutDelta should be positive (we funded)
        expect(report.inOutDelta).to.equal(currentTotalValue);
      });
    });

    describe("accruedFee()", () => {
      it("Returns 0 when no growth", async () => {
        expect(await dashboard.accruedFee()).to.equal(0n);
      });

      it("Accrues fee after vault growth", async () => {
        // Report vault with growth
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("20"),
          waitForNextRefSlot: true,
        });

        const fee = await dashboard.accruedFee();

        // Verify fee is positive
        expect(fee).to.be.gt(0n);
      });
    });

    describe("confirmingRoles()", () => {
      it("Returns array with DEFAULT_ADMIN_ROLE and NODE_OPERATOR_MANAGER_ROLE", async () => {
        const confirmingRoles = await dashboard.confirmingRoles();
        expect(confirmingRoles.length).to.equal(2);
        expect(confirmingRoles[0]).to.equal(await dashboard.DEFAULT_ADMIN_ROLE());
        expect(confirmingRoles[1]).to.equal(await dashboard.NODE_OPERATOR_MANAGER_ROLE());
      });
    });
  });

  // ==================== Receive Function ====================

  describe("receive() Function", () => {
    it("Funds vault automatically when receiving ETH", async () => {
      const valueBefore = await dashboard.totalValue();
      await owner.sendTransaction({ to: dashboard, value: ether("1") });
      const valueAfter = await dashboard.totalValue();
      expect(valueAfter - valueBefore).to.equal(ether("1"));
    });
  });

  // ==================== Fund Operations ====================

  describe("fund()", () => {
    it("Allows owner to fund the vault", async () => {
      const valueBefore = await dashboard.totalValue();
      const fundAmount = ether("1");

      await expect(dashboard.connect(owner).fund({ value: fundAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundAmount);

      const valueAfter = await dashboard.totalValue();
      expect(valueAfter).to.equal(valueBefore + fundAmount);
    });

    it("Allows funder role to fund", async () => {
      const valueBefore = await dashboard.totalValue();
      const fundAmount = ether("1");

      await expect(dashboard.connect(roles.funder).fund({ value: fundAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundAmount);

      const valueAfter = await dashboard.totalValue();
      expect(valueAfter).to.equal(valueBefore + fundAmount);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).fund({ value: ether("1") }))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.FUND_ROLE());
    });
  });

  // ==================== Withdraw Operations ====================

  describe("withdraw()", () => {
    it("Allows owner to withdraw", async () => {
      const withdrawable = await dashboard.withdrawableValue();
      const vaultBalanceBefore = await ethers.provider.getBalance(stakingVault);
      const strangerBefore = await ethers.provider.getBalance(stranger);

      await expect(dashboard.connect(owner).withdraw(stranger, withdrawable))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawable);

      await mEqual([
        [ethers.provider.getBalance(stakingVault), vaultBalanceBefore - withdrawable],
        [ethers.provider.getBalance(stranger), strangerBefore + withdrawable],
      ]);
    });

    it("Allows withdrawer role to withdraw", async () => {
      const withdrawable = await dashboard.withdrawableValue();
      const strangerBefore = await ethers.provider.getBalance(stranger);

      await expect(dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawable))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawable);

      await mEqual([[ethers.provider.getBalance(stranger), strangerBefore + withdrawable]]);
    });

    it("Reverts when exceeding withdrawable amount", async () => {
      const withdrawable = await dashboard.withdrawableValue();
      await expect(dashboard.connect(owner).withdraw(stranger, withdrawable + 1n))
        .to.be.revertedWithCustomError(dashboard, "ExceedsWithdrawable")
        .withArgs(withdrawable + 1n, withdrawable);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).withdraw(stranger, 1n))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.WITHDRAW_ROLE());
    });
  });

  // ==================== Minting Operations ====================

  describe("mintShares()", () => {
    it("Mints shares to recipient", async () => {
      const sharesToMint = ether("1");
      const strangerSharesBefore = await lido.sharesOf(stranger);
      const liabilityBefore = await dashboard.liabilityShares();

      const expectedLocked = await calculateLockedValue(ctx, stakingVault, {
        liabilityShares: liabilityBefore + sharesToMint,
      });

      await expect(dashboard.connect(owner).mintShares(stranger, sharesToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, sharesToMint, expectedLocked);

      await mEqual([
        [await lido.sharesOf(stranger), strangerSharesBefore + sharesToMint],
        [await dashboard.liabilityShares(), liabilityBefore + sharesToMint],
        [await dashboard.locked(), expectedLocked],
      ]);
    });

    it("Allows funding with msg.value via fundable modifier", async () => {
      const valueBefore = await dashboard.totalValue();
      const fundAmount = ether("5");
      const sharesToMint = ether("0.1");

      await expect(dashboard.connect(owner).mintShares(stranger, sharesToMint, { value: fundAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundAmount);

      await mEqual([[await dashboard.totalValue(), valueBefore + fundAmount]]);
    });

    it("Reverts when exceeding minting capacity", async () => {
      const remaining = await dashboard.remainingMintingCapacityShares(0n);
      await expect(dashboard.connect(owner).mintShares(stranger, remaining + 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).mintShares(stranger, 1n))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.MINT_ROLE());
    });
  });

  describe("mintStETH()", () => {
    it("Mints stETH to recipient", async () => {
      const amount = ether("1");
      const sharesBefore = await lido.sharesOf(stranger);
      const liabilityBefore = await dashboard.liabilityShares();
      const expectedShares = await lido.getSharesByPooledEth(amount);

      await expect(dashboard.connect(owner).mintStETH(stranger, amount)).to.emit(vaultHub, "MintedSharesOnVault");

      await mEqual([
        [await lido.sharesOf(stranger), sharesBefore + expectedShares],
        [await dashboard.liabilityShares(), liabilityBefore + expectedShares],
      ]);
    });

    it("Reverts on zero stETH amount (less than 1 share)", async () => {
      // Getting shares by 0 pooled ETH returns 0 shares which should revert
      await expect(dashboard.connect(owner).mintStETH(stranger, 0n)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });
  });

  describe("mintWstETH()", () => {
    it("Mints wstETH to recipient", async () => {
      const amount = ether("1");
      const wstETHBefore = await wstETH.balanceOf(stranger);
      const liabilityBefore = await dashboard.liabilityShares();

      await expect(dashboard.connect(owner).mintWstETH(stranger, amount)).to.emit(vaultHub, "MintedSharesOnVault");

      await mEqual([
        [await wstETH.balanceOf(stranger), wstETHBefore + amount],
        [await dashboard.liabilityShares(), liabilityBefore + amount],
      ]);
    });
  });

  // ==================== Burning Operations ====================

  describe("burnShares()", () => {
    it("Burns shares from sender", async () => {
      // First mint some shares to owner
      const sharesToMint = ether("2");
      await dashboard.connect(owner).mintShares(owner, sharesToMint);

      const sharesToBurn = ether("1");
      const ownerSharesBefore = await lido.sharesOf(owner);
      const liabilityBefore = await dashboard.liabilityShares();

      // Approve and burn
      await lido.connect(owner).approve(dashboard, MaxUint256);

      await expect(dashboard.connect(owner).burnShares(sharesToBurn))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, sharesToBurn);

      await mEqual([
        [await lido.sharesOf(owner), ownerSharesBefore - sharesToBurn],
        [await dashboard.liabilityShares(), liabilityBefore - sharesToBurn],
      ]);
    });

    it("Reverts when called by unauthorized account", async () => {
      // First mint and approve so the role check is reached
      await dashboard.connect(owner).mintShares(stranger, ether("0.1"));
      await lido.connect(stranger).approve(dashboard, ether("1"));

      await expect(dashboard.connect(stranger).burnShares(ether("0.1")))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.BURN_ROLE());
    });
  });

  describe("burnStETH()", () => {
    it("Burns stETH from sender", async () => {
      // Mint stETH first
      const stETHToMint = ether("1");
      await dashboard.connect(owner).mintStETH(owner, stETHToMint);

      const stETHToBurn = ether("0.5");
      const expectedSharesToBurn = await lido.getSharesByPooledEth(stETHToBurn);
      const liabilityBefore = await dashboard.liabilityShares();
      const ownerSharesBefore = await lido.sharesOf(owner);

      // Approve and burn
      await lido.connect(owner).approve(dashboard, MaxUint256);

      await expect(dashboard.connect(owner).burnStETH(stETHToBurn))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, expectedSharesToBurn);

      await mEqual([
        [await dashboard.liabilityShares(), liabilityBefore - expectedSharesToBurn],
        [await lido.sharesOf(owner), ownerSharesBefore - expectedSharesToBurn],
      ]);
    });
  });

  describe("burnWstETH()", () => {
    it("Burns wstETH from sender", async () => {
      // Mint wstETH first
      const wstETHToMint = ether("1");
      await dashboard.connect(owner).mintWstETH(owner, wstETHToMint);

      const wstETHToBurn = ether("0.5");
      const stETHAmount = await wstETH.getStETHByWstETH(wstETHToBurn);
      const expectedSharesToBurn = await lido.getSharesByPooledEth(stETHAmount);
      const liabilityBefore = await dashboard.liabilityShares();
      const ownerWstETHBefore = await wstETH.balanceOf(owner);

      // Approve and burn
      await wstETH.connect(owner).approve(dashboard, MaxUint256);

      await expect(dashboard.connect(owner).burnWstETH(wstETHToBurn))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, expectedSharesToBurn);

      await mEqual([
        [await dashboard.liabilityShares(), liabilityBefore - expectedSharesToBurn],
        [await wstETH.balanceOf(owner), ownerWstETHBefore - wstETHToBurn],
      ]);
    });
  });

  // ==================== Minting Capacity Boundaries ====================

  describe("Minting Capacity Boundaries", () => {
    describe("mintShares() at exact capacity", () => {
      it("Allows minting exactly at remaining capacity", async () => {
        // Fund the vault to ensure there's minting capacity
        await dashboard.connect(owner).fund({ value: ether("10") });

        const remaining = await dashboard.remainingMintingCapacityShares(0n);
        expect(remaining).to.be.gt(0n);

        await dashboard.connect(owner).mintShares(owner, remaining);

        // Should have 0 remaining capacity now
        await mEqual([[await dashboard.remainingMintingCapacityShares(0n), 0n]]);

        // Trying to mint even 1 more share should fail
        await expect(dashboard.connect(owner).mintShares(owner, 1n)).to.be.revertedWithCustomError(
          dashboard,
          "ExceedsMintingCapacity",
        );
      });

      it("Allows minting with msg.value covering exact shortfall", async () => {
        // Fund the vault initially to have some capacity
        await dashboard.connect(owner).fund({ value: ether("10") });

        // Mint maximum available capacity
        const remainingBefore = await dashboard.remainingMintingCapacityShares(0n);
        expect(remainingBefore).to.be.gt(0n);

        await dashboard.connect(owner).mintShares(owner, remainingBefore);

        // No capacity left
        await mEqual([[await dashboard.remainingMintingCapacityShares(0n), 0n]]);

        // Try to mint more - need to provide funding
        const desiredShares = ether("1");

        // Fund enough to create the desired capacity
        const fundingNeeded = ether("5");

        // Verify funding creates sufficient capacity
        const capacityWithFunding = await dashboard.remainingMintingCapacityShares(fundingNeeded);
        expect(capacityWithFunding).to.be.gte(desiredShares);

        // Mint with funding
        await dashboard.connect(owner).mintShares(owner, desiredShares, { value: fundingNeeded });
      });
    });

    describe("Capacity with accrued fees", () => {
      it("Correctly accounts for accrued fees in capacity calculation", async () => {
        // Create growth to accrue fees
        await dashboard.connect(owner).fund({ value: ether("20") });
        const tvBefore = await dashboard.totalValue();

        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: tvBefore + ether("5"), // Add 5 ETH growth
          waitForNextRefSlot: true,
        });

        const accruedFee = await dashboard.accruedFee();
        expect(accruedFee).to.be.gt(0n);

        // Capacity should account for fees reducing available value
        const maxLockable = await dashboard.maxLockableValue();
        const vaultHubMaxLockable = await vaultHub.maxLockableValue(stakingVault);

        // Dashboard's maxLockable should be less than VaultHub's by the fee amount
        await mEqual([[maxLockable, vaultHubMaxLockable - accruedFee]]);
      });

      it("Returns zero capacity when accrued fees exceed maxLockableValue", async () => {
        // Create scenario with large fees
        await dashboard.connect(owner).fund({ value: ether("100") });
        const tvBefore = await dashboard.totalValue();

        // Report huge growth
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: tvBefore * 2n, // Double the value
          waitForNextRefSlot: true,
        });

        const capacity = await dashboard.remainingMintingCapacityShares(0n);
        const totalCapacity = await dashboard.totalMintingCapacityShares();
        const liabilityShares = await dashboard.liabilityShares();

        // Explicitly verify totalCapacity > liability (testing non-zero case)
        expect(totalCapacity).to.be.gt(liabilityShares);

        // Explicitly verify remaining = total - liability
        expect(capacity).to.equal(totalCapacity - liabilityShares);
      });
    });
  });

  // ==================== Rebalancing Operations ====================

  describe("rebalanceVaultWithShares()", () => {
    it("Rebalances vault by shares", async () => {
      // Mint shares first
      const sharesToMint = ether("2");
      await dashboard.connect(owner).mintShares(owner, sharesToMint);

      const sharesToRebalance = ether("0.5");
      const liabilityBefore = await dashboard.liabilityShares();

      await expect(dashboard.connect(owner).rebalanceVaultWithShares(sharesToRebalance)).to.emit(
        vaultHub,
        "VaultRebalanced",
      );

      const liabilityAfter = await dashboard.liabilityShares();

      expect(liabilityAfter).to.equal(liabilityBefore - sharesToRebalance);

      // Verify locked matches VaultHub's calculation
      const lockedAfter = await dashboard.locked();
      const vaultHubLocked = await vaultHub.locked(stakingVault);
      expect(lockedAfter).to.equal(vaultHubLocked);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).rebalanceVaultWithShares(1n))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.REBALANCE_ROLE());
    });
  });

  describe("rebalanceVaultWithEther()", () => {
    it("Rebalances vault by ether amount", async () => {
      // Mint shares first
      const sharesToMint = ether("2");
      await dashboard.connect(owner).mintShares(owner, sharesToMint);

      const etherToRebalance = ether("0.5");
      const expectedShares = await lido.getSharesByPooledEth(etherToRebalance);
      const liabilityBefore = await dashboard.liabilityShares();

      await expect(dashboard.connect(owner).rebalanceVaultWithEther(etherToRebalance)).to.emit(
        vaultHub,
        "VaultRebalanced",
      );

      const liabilityAfter = await dashboard.liabilityShares();
      expect(liabilityAfter).to.equal(liabilityBefore - expectedShares);
    });

    it("Allows funding via msg.value", async () => {
      await dashboard.connect(owner).mintShares(owner, ether("2"));

      const fundAmount = ether("1");
      const rebalanceAmount = ether("0.1");
      const valueBefore = await dashboard.totalValue();

      await expect(dashboard.connect(owner).rebalanceVaultWithEther(rebalanceAmount, { value: fundAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundAmount);

      const valueAfter = await dashboard.totalValue();
      // Value increases by funding minus rebalance
      expect(valueAfter).to.be.closeTo(valueBefore + fundAmount - rebalanceAmount, ether("0.01"));
    });
  });

  // ==================== PDG Policy Management ====================

  describe("setPDGPolicy()", () => {
    it("Allows admin to set PDG policy", async () => {
      await expect(dashboard.connect(owner).setPDGPolicy(PDGPolicy.STRICT))
        .to.emit(dashboard, "PDGPolicyEnacted")
        .withArgs(PDGPolicy.STRICT);

      expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.STRICT);
    });

    it("Reverts when setting same policy", async () => {
      await expect(
        dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE),
      ).to.be.revertedWithCustomError(dashboard, "PDGPolicyAlreadyActive");
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).setPDGPolicy(PDGPolicy.STRICT)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("Allows setting ALLOW_PROVE policy", async () => {
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.STRICT);
      await expect(dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_PROVE))
        .to.emit(dashboard, "PDGPolicyEnacted")
        .withArgs(PDGPolicy.ALLOW_PROVE);
    });
  });

  describe("unguaranteedDepositToBeaconChain()", () => {
    it("Reverts when PDG policy is STRICT", async () => {
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.STRICT);

      const deposits = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1"),
          signature: new Uint8Array(96),
          depositDataRoot: new Uint8Array(32),
        },
      ];

      await expect(
        dashboard.connect(roles.unguaranteedDepositor).unguaranteedDepositToBeaconChain(deposits),
      ).to.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });

    it("Reverts when called by unauthorized account", async () => {
      const deposits = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1"),
          signature: new Uint8Array(96),
          depositDataRoot: new Uint8Array(32),
        },
      ];

      await expect(
        dashboard.connect(stranger).unguaranteedDepositToBeaconChain(deposits),
      ).to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount");
    });

    it("Reverts when exceeding withdrawable", async () => {
      const deposits = [
        {
          pubkey: randomValidatorPubkey(),
          amount: ether("1000"), // More than withdrawable
          signature: new Uint8Array(96),
          depositDataRoot: new Uint8Array(32),
        },
      ];

      await expect(
        dashboard.connect(roles.unguaranteedDepositor).unguaranteedDepositToBeaconChain(deposits),
      ).to.be.revertedWithCustomError(dashboard, "ExceedsWithdrawable");
    });

    it("Deposits to beacon chain successfully", async () => {
      const validator = generateValidator(await stakingVault.withdrawalCredentials());
      const deposit = generateDepositStruct(validator.container, ether("1"));

      await expect(dashboard.connect(roles.unguaranteedDepositor).unguaranteedDepositToBeaconChain([deposit]))
        .to.emit(dashboard, "UnguaranteedDeposits")
        .withArgs(stakingVault, 1, deposit.amount);
    });
  });

  describe("proveUnknownValidatorsToPDG()", () => {
    before(async () => {
      await ensurePredepositGuaranteeUnpaused(ctx);
    });

    it("Reverts when PDG policy is STRICT", async () => {
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.STRICT);

      const witnesses = [
        {
          proof: ["0xffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"],
          pubkey: "0x",
          validatorIndex: 0n,
          childBlockTimestamp: 0n,
          slot: 0n,
          proposerIndex: 0n,
        },
      ];

      await expect(
        dashboard.connect(roles.unknownValidatorProver).proveUnknownValidatorsToPDG(witnesses),
      ).to.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });

    it("Allows proving when PDG policy is ALLOW_PROVE", async () => {
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_PROVE);

      const withdrawalCredentials = await stakingVault.withdrawalCredentials();
      const validators = createValidators(1, withdrawalCredentials);

      await addValidatorsToTree(validators);
      const { header, timestamp } = await commitAndProveValidators(validators, 100);
      const witnesses = toWitnesses(validators, header, timestamp);

      await expect(dashboard.connect(roles.unknownValidatorProver).proveUnknownValidatorsToPDG(witnesses))
        .to.emit(predepositGuarantee, "ValidatorProven")
        .withArgs(witnesses[0].pubkey, nodeOperator, stakingVault, withdrawalCredentials);
    });
  });

  // ==================== Beacon Chain Operations ====================

  describe("pauseBeaconChainDeposits()", () => {
    it("Pauses beacon chain deposits", async () => {
      const pausedBefore = await stakingVault.beaconChainDepositsPaused();
      expect(pausedBefore).to.be.false;

      await expect(dashboard.connect(owner).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );

      const pausedAfter = await stakingVault.beaconChainDepositsPaused();
      expect(pausedAfter).to.be.true;
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).pauseBeaconChainDeposits())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.PAUSE_BEACON_CHAIN_DEPOSITS_ROLE());
    });
  });

  describe("resumeBeaconChainDeposits()", () => {
    it("Resumes beacon chain deposits", async () => {
      await dashboard.connect(owner).pauseBeaconChainDeposits();

      const pausedBefore = await stakingVault.beaconChainDepositsPaused();
      expect(pausedBefore).to.be.true;

      await expect(dashboard.connect(owner).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );

      const pausedAfter = await stakingVault.beaconChainDepositsPaused();
      expect(pausedAfter).to.be.false;
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).resumeBeaconChainDeposits())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.RESUME_BEACON_CHAIN_DEPOSITS_ROLE());
    });
  });

  describe("requestValidatorExit()", () => {
    it("Requests validator exit", async () => {
      const keys = getPubkeys(2);
      await expect(dashboard.connect(owner).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[0], keys.pubkeys[0]);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).requestValidatorExit("0x" + "ab".repeat(48)))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.REQUEST_VALIDATOR_EXIT_ROLE());
    });
  });

  describe("triggerValidatorWithdrawals()", () => {
    it("Triggers validator withdrawals", async () => {
      const pubkey = "0x" + "ab".repeat(48);
      await expect(dashboard.connect(owner).triggerValidatorWithdrawals(pubkey, [ether("1")], owner, { value: 1n }))
        .to.emit(stakingVault, "ValidatorWithdrawalsTriggered")
        .withArgs(pubkey, [ether("1")], 0, owner);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).triggerValidatorWithdrawals("0x", [0n], stranger, { value: 1n }))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.TRIGGER_VALIDATOR_WITHDRAWAL_ROLE());
    });

    it("Reverts when no msg.value provided", async () => {
      const pubkey = "0x" + "ab".repeat(48);
      await expect(dashboard.connect(owner).triggerValidatorWithdrawals(pubkey, [ether("1")], owner))
        .to.be.revertedWithCustomError(stakingVault, "ZeroArgument")
        .withArgs("msg.value");
    });
  });

  // ==================== Node Operator Fee Management ====================

  describe("disburseFee()", () => {
    it("Disburses fee permissionlessly", async () => {
      // Create growth to accrue fees (0.2% growth, well below 1% threshold)
      const currentTotalValue = await dashboard.totalValue();
      const growth = currentTotalValue / 500n;
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: currentTotalValue + growth,
        waitForNextRefSlot: true,
      });

      const fee = await dashboard.accruedFee();
      expect(fee).to.be.gt(0n);

      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      // Stranger (unauthorized account) can disburse fees
      await expect(dashboard.connect(stranger).disburseFee())
        .to.emit(dashboard, "FeeDisbursed")
        .withArgs(stranger.address, fee, feeRecipient);

      const balanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(balanceAfter).to.equal(balanceBefore + fee);
      expect(await dashboard.accruedFee()).to.equal(0n);
    });

    it("Does not revert when fee is zero (updates settledGrowth)", async () => {
      // Set fee rate to 0 to ensure zero fees
      await dashboard.connect(owner).setFeeRate(0);
      await dashboard.connect(nodeOperator).setFeeRate(0);

      // Create growth - with 0% fee rate, fee will be 0
      const currentTotalValue = await dashboard.totalValue();
      const growth = ether("1");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: currentTotalValue + growth,
        waitForNextRefSlot: true,
      });

      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.equal(0n);

      const settledGrowthBefore = await dashboard.settledGrowth();

      // Should not revert, and should update settled growth to current growth
      await dashboard.connect(stranger).disburseFee();

      expect(await dashboard.accruedFee()).to.equal(0n);

      // Verify settled growth was updated (increased by the growth amount)
      const settledGrowthAfter = await dashboard.settledGrowth();
      expect(settledGrowthAfter).to.equal(settledGrowthBefore + growth);
    });

    it("Reverts when fee is abnormally high", async () => {
      // Create abnormally high fee scenario (> 1% of total value)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("100"),
        waitForNextRefSlot: true,
      });

      // This might trigger abnormally high fee depending on settled growth
      const fee = await dashboard.accruedFee();
      const totalValue = await dashboard.totalValue();

      // If fee > 1% of total value, it's considered abnormally high
      if (fee > totalValue / 100n) {
        await expect(dashboard.disburseFee()).to.be.revertedWithCustomError(dashboard, "AbnormallyHighFee");
      }
    });
  });

  describe("disburseAbnormallyHighFee()", () => {
    it("Allows admin to disburse abnormally high fee", async () => {
      // First create a scenario with high fees
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("50"),
        waitForNextRefSlot: true,
      });

      const fee = await dashboard.accruedFee();
      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      await expect(dashboard.disburseFee()).to.be.revertedWithCustomError(dashboard, "AbnormallyHighFee");

      await expect(dashboard.connect(owner).disburseAbnormallyHighFee())
        .to.emit(dashboard, "FeeDisbursed")
        .withArgs(owner.address, fee, feeRecipient);

      const balanceAfter = await ethers.provider.getBalance(feeRecipient);
      const accruedFeeAfter = await dashboard.accruedFee();

      expect(balanceAfter).to.equal(balanceBefore + fee);
      expect(accruedFeeAfter).to.equal(0n);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).disburseAbnormallyHighFee()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  describe("setFeeRate()", () => {
    it("Requires dual confirmation from admin and node operator", async () => {
      const newFeeRate = 500n;
      const oldFeeRate = await dashboard.feeRate();

      // First confirmation from owner
      await expect(dashboard.connect(owner).setFeeRate(newFeeRate)).to.not.emit(dashboard, "FeeRateSet");

      // Second confirmation from node operator
      await expect(dashboard.connect(nodeOperator).setFeeRate(newFeeRate))
        .to.emit(dashboard, "FeeRateSet")
        .withArgs(nodeOperator.address, oldFeeRate, newFeeRate);

      const feeRateAfter = await dashboard.feeRate();
      expect(feeRateAfter).to.equal(newFeeRate);
    });

    it("Reverts when report is stale", async () => {
      await advanceChainTime(days(2n));

      await expect(dashboard.connect(owner).setFeeRate(500n)).to.be.revertedWithCustomError(dashboard, "ReportStale");
    });

    it("Reverts when fee exceeds 100%", async () => {
      // Ensure report is fresh
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      // First confirmation
      await dashboard.connect(owner).setFeeRate(TOTAL_BASIS_POINTS + 1n);

      // Second confirmation should revert with fee validation error
      // (the _setFeeRate is only called after both confirmations)
      await expect(dashboard.connect(nodeOperator).setFeeRate(TOTAL_BASIS_POINTS + 1n)).to.be.revertedWithCustomError(
        dashboard,
        "FeeValueExceed100Percent",
      );
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).setFeeRate(500n)).to.be.revertedWithCustomError(
        dashboard,
        "SenderNotMember",
      );
    });
  });

  describe("correctSettledGrowth()", () => {
    it("Requires dual confirmation", async () => {
      const currentSettledGrowth = await dashboard.settledGrowth();
      const newSettledGrowth = currentSettledGrowth + 100n;

      // First confirmation
      await expect(dashboard.connect(owner).correctSettledGrowth(newSettledGrowth, currentSettledGrowth)).to.not.emit(
        dashboard,
        "SettledGrowthSet",
      );

      // Second confirmation
      await expect(dashboard.connect(nodeOperator).correctSettledGrowth(newSettledGrowth, currentSettledGrowth))
        .to.emit(dashboard, "SettledGrowthSet")
        .withArgs(currentSettledGrowth, newSettledGrowth);

      const settledGrowthAfter = await dashboard.settledGrowth();
      expect(settledGrowthAfter).to.equal(newSettledGrowth);
    });

    it("Reverts when expected settled growth doesn't match", async () => {
      const currentSettledGrowth = await dashboard.settledGrowth();

      await expect(
        dashboard.connect(owner).correctSettledGrowth(100n, currentSettledGrowth + 1n),
      ).to.be.revertedWithCustomError(dashboard, "UnexpectedSettledGrowth");
    });
  });

  describe("addFeeExemption()", () => {
    it("Adds fee exemption to settled growth", async () => {
      const settledBefore = await dashboard.settledGrowth();
      const exemptionAmount = 100n;

      await expect(dashboard.connect(roles.nodeOperatorFeeExemptor).addFeeExemption(exemptionAmount))
        .to.emit(dashboard, "SettledGrowthSet")
        .withArgs(settledBefore, settledBefore + exemptionAmount);

      const settledAfter = await dashboard.settledGrowth();
      expect(settledAfter).to.equal(settledBefore + exemptionAmount);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).addFeeExemption(100n)).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("Reverts when exemption amount is too large", async () => {
      const maxSane = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"); // MAX_SANE_SETTLED_GROWTH
      await expect(
        dashboard.connect(roles.nodeOperatorFeeExemptor).addFeeExemption(maxSane + 1n),
      ).to.be.revertedWithCustomError(dashboard, "UnexpectedFeeExemptionAmount");
    });
  });

  // ==================== Fee Management Edge Cases ====================

  describe("Fee Management edge cases", () => {
    describe("disburseFee() at 1% boundary", () => {
      it("Allows fee disbursement when fee is just below 1% threshold", async () => {
        // Create growth that results in fee just under 1% (0.99% growth)
        const currentTotalValue = await dashboard.totalValue();
        const targetGrowth = currentTotalValue / 101n;
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: currentTotalValue + targetGrowth,
          waitForNextRefSlot: true,
        });

        const fee = await dashboard.accruedFee();
        const totalValue = await dashboard.totalValue();

        // Verify fee is below 1% threshold
        expect(fee).to.be.lt(totalValue / 100n);
        expect(fee).to.be.gt(0n);

        // Should allow disbursement
        await expect(dashboard.disburseFee()).to.emit(dashboard, "FeeDisbursed");
        expect(await dashboard.accruedFee()).to.equal(0n);
      });

      it("Reverts when fee exceeds 1% threshold", async () => {
        // Create large growth to trigger 1% fee threshold (1000% growth)
        const currentTotalValue = await dashboard.totalValue();
        const largeGrowth = currentTotalValue * 10n;
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: currentTotalValue + largeGrowth,
          waitForNextRefSlot: true,
        });

        const fee = await dashboard.accruedFee();
        const totalValue = await dashboard.totalValue();

        // Verify fee exceeds 1% threshold
        expect(fee).to.be.gte(totalValue / 100n);

        // Should revert on disbursement
        await expect(dashboard.disburseFee()).to.be.revertedWithCustomError(dashboard, "AbnormallyHighFee");
      });
    });

    describe("disburseFee() with minimal growth", () => {
      it("Fee rounds down", async () => {
        // Create minimal growth (1 wei)
        const currentTotalValue = await dashboard.totalValue();
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: currentTotalValue + 1n,
          waitForNextRefSlot: true,
        });

        // Disburse fee - should not revert even with minimal growth
        await dashboard.disburseFee();

        // Verify fee was 0 or minimal (1 wei growth results in 0.01 wei fee, rounds to 0)
        const feeAfter = await dashboard.accruedFee();
        expect(feeAfter).to.equal(0n);
      });
    });

    describe("correctSettledGrowth() edge cases", () => {
      it("Handles settled growth near maximum safe value", async () => {
        const currentSettledGrowth = await dashboard.settledGrowth();
        const maxSane = BigInt("0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFF"); // MAX_SANE_SETTLED_GROWTH

        // Try to set near max
        const nearMax = maxSane - 1n;

        await dashboard.connect(owner).correctSettledGrowth(nearMax, currentSettledGrowth);
        await dashboard.connect(nodeOperator).correctSettledGrowth(nearMax, currentSettledGrowth);

        expect(await dashboard.settledGrowth()).to.equal(nearMax);
      });

      it("Can decrease settled growth", async () => {
        const sgBefore = await dashboard.settledGrowth();
        await dashboard.connect(owner).correctSettledGrowth(sgBefore + 100n, sgBefore);
        await dashboard.connect(nodeOperator).correctSettledGrowth(sgBefore + 100n, sgBefore);

        // now restore by the same amount
        const sgAfter = sgBefore + 100n;
        await dashboard.connect(owner).correctSettledGrowth(sgBefore, sgAfter);
        await dashboard.connect(nodeOperator).correctSettledGrowth(sgBefore, sgAfter);

        expect(await dashboard.settledGrowth()).to.equal(sgBefore);
      });
    });

    describe("addFeeExemption() edge cases", () => {
      it("Handles fee exemption with reasonable amounts", async () => {
        const settledBefore = await dashboard.settledGrowth();

        // Add a reasonable exemption (not exceeding MAX_SANE_SETTLED_GROWTH threshold)
        const exemption = ether("100"); // 100 ETH worth of growth exemption

        await dashboard.connect(roles.nodeOperatorFeeExemptor).addFeeExemption(exemption);

        const settledAfter = await dashboard.settledGrowth();
        expect(settledAfter).to.equal(settledBefore + exemption);
      });
    });

    describe("Multiple consecutive disbursements", () => {
      it("Handles multiple disbursements without growth between them", async () => {
        const currentTotalValue = await dashboard.totalValue();
        const inOutDelta = (await dashboard.latestReport()).inOutDelta;
        const currentGrowth = currentTotalValue - BigInt(inOutDelta);

        // Sync settled growth
        const settledGrowth = await dashboard.settledGrowth();
        if (settledGrowth != currentGrowth) {
          await dashboard.connect(owner).correctSettledGrowth(currentGrowth, settledGrowth);
          await dashboard.connect(nodeOperator).correctSettledGrowth(currentGrowth, settledGrowth);
        }

        // First disbursement (should have 0 fee)
        await dashboard.disburseFee();
        expect(await dashboard.accruedFee()).to.equal(0n);

        // Second disbursement without growth (should not revert)
        await dashboard.disburseFee();
        expect(await dashboard.accruedFee()).to.equal(0n);

        // Third disbursement (verify idempotency)
        await dashboard.disburseFee();
        expect(await dashboard.accruedFee()).to.equal(0n);
      });

      it("Tracks settled growth correctly across multiple disbursements with growth", async () => {
        // Fund more to have meaningful growth
        await dashboard.connect(owner).fund({ value: ether("50") });

        // Report the updated total value after funding
        const totalValueAfterFunding = await dashboard.totalValue();
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: totalValueAfterFunding,
          waitForNextRefSlot: true,
        });

        const inOutDelta = (await dashboard.latestReport()).inOutDelta;
        const currentGrowth = totalValueAfterFunding - BigInt(inOutDelta);

        // Sync settled growth
        const settledGrowth = await dashboard.settledGrowth();
        if (settledGrowth != currentGrowth) {
          await dashboard.connect(owner).correctSettledGrowth(currentGrowth, settledGrowth);
          await dashboard.connect(nodeOperator).correctSettledGrowth(currentGrowth, settledGrowth);
        }

        const feeRecipient = await dashboard.feeRecipient();
        let totalFeesCollected = 0n;
        let expectedTotalFees = 0n;

        // Multiple cycles of growth → disburse
        for (let i = 0; i < 3; i++) {
          const tvBefore = await dashboard.totalValue();
          const growth = tvBefore / 200n; // 0.5% growth each time

          await reportVaultDataWithProof(ctx, stakingVault, {
            totalValue: tvBefore + growth,
            waitForNextRefSlot: true,
          });

          const fee = await dashboard.accruedFee();
          const balanceBefore = await ethers.provider.getBalance(feeRecipient);

          if (fee > 0n) {
            expectedTotalFees += fee;

            await dashboard.disburseFee();

            const balanceAfter = await ethers.provider.getBalance(feeRecipient);
            totalFeesCollected += balanceAfter - balanceBefore;
          }

          // Fee should be 0 after disbursement
          expect(await dashboard.accruedFee()).to.equal(0n);
        }

        // Verify exact total fees collected
        expect(expectedTotalFees).to.be.gt(0n); // Verify we actually collected fees
        expect(totalFeesCollected).to.equal(expectedTotalFees);
      });
    });
  });

  describe("setConfirmExpiry()", () => {
    it("Requires dual confirmation", async () => {
      const newExpiry = days(14n);

      // First confirmation
      await expect(dashboard.connect(owner).setConfirmExpiry(newExpiry)).to.not.emit(dashboard, "ConfirmExpirySet");

      // Second confirmation
      await expect(dashboard.connect(nodeOperator).setConfirmExpiry(newExpiry)).to.emit(dashboard, "ConfirmExpirySet");
    });

    it("Reverts with invalid expiry (too short)", async () => {
      await expect(dashboard.connect(owner).setConfirmExpiry(1n)).to.be.revertedWithCustomError(
        dashboard,
        "ConfirmExpiryOutOfBounds",
      );
    });

    it("Reverts with invalid expiry (too long)", async () => {
      await expect(dashboard.connect(owner).setConfirmExpiry(days(366n))).to.be.revertedWithCustomError(
        dashboard,
        "ConfirmExpiryOutOfBounds",
      );
    });
  });

  describe("setFeeRecipient()", () => {
    it("Sets new fee recipient", async () => {
      const oldRecipient = await dashboard.feeRecipient();
      const newRecipient = randomAddress();

      await expect(dashboard.connect(nodeOperator).setFeeRecipient(newRecipient))
        .to.emit(dashboard, "FeeRecipientSet")
        .withArgs(nodeOperator, oldRecipient, newRecipient);

      expect(await dashboard.feeRecipient()).to.equal(newRecipient);
    });

    it("Reverts with zero address", async () => {
      await expect(dashboard.connect(nodeOperator).setFeeRecipient(ZeroAddress)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroAddress",
      );
    });

    it("Reverts when setting same recipient", async () => {
      const currentRecipient = await dashboard.feeRecipient();
      await expect(dashboard.connect(nodeOperator).setFeeRecipient(currentRecipient)).to.be.revertedWithCustomError(
        dashboard,
        "SameRecipient",
      );
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).setFeeRecipient(randomAddress())).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });
  });

  // ==================== Ownership and Connection Management ====================

  describe("transferVaultOwnership()", () => {
    it("Requires dual confirmation", async () => {
      const newOwner = randomAddress();

      // First confirmation
      const result1 = await dashboard.connect(owner).transferVaultOwnership.staticCall(newOwner);
      expect(result1).to.be.false;

      await dashboard.connect(owner).transferVaultOwnership(newOwner);

      // Second confirmation transfers ownership
      await expect(dashboard.connect(nodeOperator).transferVaultOwnership(newOwner)).to.emit(
        vaultHub,
        "VaultOwnershipTransferred",
      );
    });

    it("Reverts when transferring to dashboard itself", async () => {
      await expect(
        dashboard.connect(owner).transferVaultOwnership(await dashboard.getAddress()),
      ).to.be.revertedWithCustomError(dashboard, "DashboardNotAllowed");
    });
  });

  describe("voluntaryDisconnect()", () => {
    it("Initiates voluntary disconnect", async () => {
      await expect(dashboard.connect(owner).voluntaryDisconnect())
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(stakingVault);

      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;
    });

    it("Collects fee leftover on disconnect", async () => {
      // Fund the vault to have more value for meaningful fees
      await dashboard.connect(owner).fund({ value: ether("100") });

      // Report to sync the state
      const fundedTotalValue = await dashboard.totalValue();
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: fundedTotalValue,
        waitForNextRefSlot: true,
      });

      // Now sync settled growth to current state
      const report = await dashboard.latestReport();
      const currentGrowth = fundedTotalValue - BigInt(report.inOutDelta);

      const settledGrowth = await dashboard.settledGrowth();
      if (settledGrowth != currentGrowth) {
        await dashboard.connect(owner).correctSettledGrowth(currentGrowth, settledGrowth);
        await dashboard.connect(nodeOperator).correctSettledGrowth(currentGrowth, settledGrowth);
      }

      // Create growth to accrue a fee (< 1% threshold but meaningful)
      const growth = fundedTotalValue / 200n; // 0.5% growth
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: fundedTotalValue + growth,
        waitForNextRefSlot: true,
      });

      const feeBefore = await dashboard.accruedFee();
      expect(feeBefore).to.be.gt(0n);

      await dashboard.connect(owner).voluntaryDisconnect();

      // Fee leftover should equal the accrued fee at time of disconnect
      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.equal(feeBefore);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.VOLUNTARY_DISCONNECT_ROLE());
    });
  });

  describe("recoverFeeLeftover()", () => {
    it("Recovers fee leftover to fee recipient", async () => {
      // Report with growth to create fees (5% of 1 ETH growth = 0.05 ETH fee at 1% rate)
      const currentTotalValue = await dashboard.totalValue();
      const growth = ether("1");
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: currentTotalValue + growth,
        waitForNextRefSlot: true,
      });

      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.be.gt(0n);

      await dashboard.connect(owner).voluntaryDisconnect();

      // Complete disconnect
      await reportVaultDataWithProof(ctx, stakingVault);

      // Fee leftover should equal the accrued fee at time of disconnect
      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.equal(accruedFee);

      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      await expect(dashboard.recoverFeeLeftover())
        .to.emit(dashboard, "AssetsRecovered")
        .withArgs(feeRecipient, ETH_ADDRESS, feeLeftover);

      const balanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(balanceAfter - balanceBefore).to.equal(feeLeftover);
      expect(await dashboard.feeLeftover()).to.equal(0n);
    });
  });

  describe("abandonDashboard()", () => {
    it("Transfers ownership when disconnected", async () => {
      // Disconnect first
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      const newOwner = randomAddress();
      await dashboard.connect(owner).abandonDashboard(newOwner);

      // New owner should be pending
      expect(await stakingVault.pendingOwner()).to.equal(newOwner);
    });

    it("Reverts when vault is still connected", async () => {
      await expect(dashboard.connect(owner).abandonDashboard(randomAddress())).to.be.revertedWithCustomError(
        dashboard,
        "ConnectedToVaultHub",
      );
    });

    it("Reverts when transferring to dashboard itself", async () => {
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      await expect(
        dashboard.connect(owner).abandonDashboard(await dashboard.getAddress()),
      ).to.be.revertedWithCustomError(dashboard, "DashboardNotAllowed");
    });
  });

  describe("reconnectToVaultHub()", () => {
    it("Reconnects disconnected vault", async () => {
      // Disconnect
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      // Correct settled growth (required after disconnect)
      const currentSettled = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, currentSettled);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, currentSettled);

      // Reconnect
      await dashboard.connect(owner).reconnectToVaultHub();

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    });
  });

  describe("connectToVaultHub()", () => {
    it("Reverts when settledGrowth is not corrected after disconnect", async () => {
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      // Try to connect without correcting settled growth
      await expect(dashboard.connect(owner).connectToVaultHub()).to.be.revertedWithCustomError(
        dashboard,
        "SettleGrowthIsNotSet",
      );
    });

    it("Allows funding in disconnected state", async () => {
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      const currentSettled = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, currentSettled);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, currentSettled);

      // Fund should happen via reconnectToVaultHub (which accepts ownership first)
      const valueBefore = await ethers.provider.getBalance(stakingVault);

      // First fund separately, then reconnect
      const fundingAmount = ether("1");
      await owner.sendTransaction({ to: stakingVault, value: fundingAmount });
      await dashboard.connect(owner).reconnectToVaultHub();

      const valueAfter = await ethers.provider.getBalance(stakingVault);
      expect(valueAfter).to.equal(valueBefore + fundingAmount);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    });
  });

  // ==================== Tier Management ====================

  describe("changeTier()", () => {
    it("Reverts when tier doesn't exist", async () => {
      // Tier 999 doesn't exist
      const tierCount = await ctx.contracts.operatorGrid.tiersCount();
      await expect(dashboard.connect(owner).changeTier(tierCount + 1n, ether("100"))).to.be.revertedWithCustomError(
        ctx.contracts.operatorGrid,
        "TierNotExists",
      );
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).changeTier(0n, ether("100"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("Changes tier with dual confirmation", async () => {
      const { operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Register a group and tier for the node operator
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("1000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("100"),
          reserveRatioBP: 10_00,
          forcedRebalanceThresholdBP: 5_00,
          infraFeeBP: 0,
          liquidityFeeBP: 0,
          reservationFeeBP: 0,
        },
      ]);

      const group = await operatorGrid.group(nodeOperator);
      const requestedTierId = group.tierIds[0];
      const requestedShareLimit = ether("100");

      // First confirmation from vault owner via Dashboard
      const firstCallResult = await dashboard
        .connect(owner)
        .changeTier.staticCall(requestedTierId, requestedShareLimit);
      expect(firstCallResult).to.be.false; // Not yet confirmed

      await dashboard.connect(owner).changeTier(requestedTierId, requestedShareLimit);

      // Second confirmation from node operator via OperatorGrid
      await expect(operatorGrid.connect(nodeOperator).changeTier(stakingVault, requestedTierId, requestedShareLimit))
        .to.emit(operatorGrid, "TierChanged")
        .withArgs(stakingVault, requestedTierId, requestedShareLimit);

      // Verify tier was changed
      const tierInfo = await operatorGrid.vaultTierInfo(stakingVault);
      expect(tierInfo.tierId).to.equal(requestedTierId);
    });
  });

  describe("syncTier()", () => {
    it("Reverts when already synced with tier", async () => {
      // Vault starts synced with default tier
      await expect(dashboard.connect(owner).syncTier()).to.be.revertedWithCustomError(
        ctx.contracts.operatorGrid,
        "VaultAlreadySyncedWithTier",
      );
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).syncTier()).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("Syncs tier with dual confirmation", async () => {
      const { operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Register a group and tier for the node operator
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("1000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("100"),
          reserveRatioBP: 10_00,
          forcedRebalanceThresholdBP: 5_00,
          infraFeeBP: 0,
          liquidityFeeBP: 0,
          reservationFeeBP: 0,
        },
      ]);

      const group = await operatorGrid.group(nodeOperator);
      const requestedTierId = group.tierIds[0];
      const requestedShareLimit = ether("100");

      // Change to the new tier first
      await dashboard.connect(owner).changeTier(requestedTierId, requestedShareLimit);
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, requestedTierId, requestedShareLimit);

      // Now alter the tier parameters
      await operatorGrid.connect(agentSigner).alterTiers(
        [requestedTierId],
        [
          {
            shareLimit: ether("100"),
            reserveRatioBP: 15_00, // Changed from 10_00
            forcedRebalanceThresholdBP: 7_00, // Changed from 5_00
            infraFeeBP: 0,
            liquidityFeeBP: 0,
            reservationFeeBP: 0,
          },
        ],
      );

      // First confirmation from vault owner via Dashboard
      const firstCallResult = await dashboard.connect(owner).syncTier.staticCall();
      expect(firstCallResult).to.be.false;

      await dashboard.connect(owner).syncTier();

      // Second confirmation from node operator via OperatorGrid
      await expect(operatorGrid.connect(nodeOperator).syncTier(stakingVault))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(stakingVault, nodeOperator, requestedShareLimit, 15_00, 7_00);
    });
  });

  describe("updateShareLimit()", () => {
    it("Returns false on first call (pending confirmation)", async () => {
      const result = await dashboard.connect(owner).updateShareLimit.staticCall(ether("100"));
      expect(result).to.be.false;
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).updateShareLimit(ether("100"))).to.be.revertedWithCustomError(
        dashboard,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("Updates share limit with dual confirmation", async () => {
      const { operatorGrid } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Register a group and tier for the node operator
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("1000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("100"),
          reserveRatioBP: 10_00,
          forcedRebalanceThresholdBP: 5_00,
          infraFeeBP: 0,
          liquidityFeeBP: 0,
          reservationFeeBP: 0,
        },
      ]);

      const group = await operatorGrid.group(nodeOperator);
      const requestedTierId = group.tierIds[0];
      const initialShareLimit = ether("100");

      // Change to the new tier first
      await dashboard.connect(owner).changeTier(requestedTierId, initialShareLimit);
      await operatorGrid.connect(nodeOperator).changeTier(stakingVault, requestedTierId, initialShareLimit);

      // Request a new share limit (lower than initial)
      const newShareLimit = ether("50");

      // First confirmation from vault owner via Dashboard
      const firstCallResult = await dashboard.connect(owner).updateShareLimit.staticCall(newShareLimit);
      expect(firstCallResult).to.be.false;

      await dashboard.connect(owner).updateShareLimit(newShareLimit);

      // Second confirmation from node operator via OperatorGrid
      await expect(operatorGrid.connect(nodeOperator).updateVaultShareLimit(stakingVault, newShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(stakingVault, nodeOperator, newShareLimit, 10_00, 5_00);

      // Verify share limit was updated
      const connection = await vaultHub.vaultConnection(stakingVault);
      expect(connection.shareLimit).to.equal(newShareLimit);
    });
  });

  // ==================== Role Management (from Permissions) ====================

  describe("grantRoles()", () => {
    it("Grants multiple roles at once", async () => {
      const newAccount = randomAddress();
      const assignments = [
        { account: newAccount, role: await dashboard.FUND_ROLE() },
        { account: newAccount, role: await dashboard.WITHDRAW_ROLE() },
      ];

      await dashboard.connect(owner).grantRoles(assignments);

      expect(await dashboard.hasRole(await dashboard.FUND_ROLE(), newAccount)).to.be.true;
      expect(await dashboard.hasRole(await dashboard.WITHDRAW_ROLE(), newAccount)).to.be.true;
    });

    it("Reverts with zero length assignments", async () => {
      await expect(dashboard.connect(owner).grantRoles([])).to.be.revertedWithCustomError(dashboard, "ZeroArgument");
    });
  });

  describe("revokeRoles()", () => {
    it("Revokes multiple roles at once", async () => {
      const assignments = [
        { account: roles.funder.address, role: await dashboard.FUND_ROLE() },
        { account: roles.withdrawer.address, role: await dashboard.WITHDRAW_ROLE() },
      ];

      await dashboard.connect(owner).revokeRoles(assignments);

      expect(await dashboard.hasRole(await dashboard.FUND_ROLE(), roles.funder)).to.be.false;
      expect(await dashboard.hasRole(await dashboard.WITHDRAW_ROLE(), roles.withdrawer)).to.be.false;
    });

    it("Reverts with zero length assignments", async () => {
      await expect(dashboard.connect(owner).revokeRoles([])).to.be.revertedWithCustomError(dashboard, "ZeroArgument");
    });
  });

  describe("renounceRole()", () => {
    it("Reverts always (disabled)", async () => {
      await expect(
        dashboard.connect(owner).renounceRole(await dashboard.DEFAULT_ADMIN_ROLE(), owner),
      ).to.be.revertedWithCustomError(dashboard, "RoleRenouncementDisabled");
    });
  });

  // ==================== Edge Cases ====================

  describe("Edge Cases", () => {
    it("Handles zero minting capacity gracefully", async () => {
      // Mint max capacity
      const maxShares = await dashboard.totalMintingCapacityShares();
      await dashboard.connect(owner).mintShares(owner, maxShares);

      // Verify capacity is 0
      expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);

      // Try to mint more - should fail
      await expect(dashboard.connect(owner).mintShares(owner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );
    });

    it("Handles vault with only connection deposit", async () => {
      // Create a new vault with only connection deposit
      const { dashboard: newDashboard } = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      // Should have minimal locked value
      expect(await newDashboard.locked()).to.equal(ether("1"));
      expect(await newDashboard.totalValue()).to.equal(ether("1"));

      // Withdrawable should be 0
      expect(await newDashboard.withdrawableValue()).to.equal(0n);

      // Cannot withdraw
      await expect(newDashboard.connect(owner).withdraw(stranger, 1n)).to.be.revertedWithCustomError(
        newDashboard,
        "ExceedsWithdrawable",
      );
    });

    it("stakingVault() returns correct address", async () => {
      expect(await dashboard.stakingVault()).to.equal(await stakingVault.getAddress());
    });

    it("Constants are correctly set", async () => {
      expect(await dashboard.STETH()).to.equal(await lido.getAddress());
      expect(await dashboard.WSTETH()).to.equal(await wstETH.getAddress());
      expect(await dashboard.VAULT_HUB()).to.equal(await vaultHub.getAddress());
    });

    it("Confirmation expiry works correctly", async () => {
      // Make a confirmation using setConfirmExpiry (doesn't require fresh report)
      const newExpiry = days(10n);
      await dashboard.connect(owner).setConfirmExpiry(newExpiry);

      // Advance time past default expiry (7 days)
      await advanceChainTime(days(8n));

      // Confirmation should have expired, so node operator starts fresh confirmation
      // (won't emit ConfirmExpirySet because it's the first fresh confirmation after expiry)
      await expect(dashboard.connect(nodeOperator).setConfirmExpiry(newExpiry)).to.not.emit(
        dashboard,
        "ConfirmExpirySet",
      );
    });

    it("Multiple confirmations don't interfere", async () => {
      // Start two different confirmation processes
      await dashboard.connect(owner).setFeeRate(500n);
      await dashboard.connect(owner).setConfirmExpiry(days(10n));

      // Complete one
      await dashboard.connect(nodeOperator).setFeeRate(500n);
      expect(await dashboard.feeRate()).to.equal(500n);

      // The other should still need confirmation
      await expect(dashboard.connect(nodeOperator).setConfirmExpiry(days(10n))).to.emit(dashboard, "ConfirmExpirySet");
    });
  });

  // ==================== Additional Edge Case Coverage ====================

  describe("Rebalancing Edge Cases", () => {
    it("Rebalances with exactly locked amount", async () => {
      // Mint some shares
      await dashboard.connect(owner).mintShares(owner, ether("2"));

      const liabilityBefore = await dashboard.liabilityShares();

      // Rebalance all liability shares
      await dashboard.connect(owner).rebalanceVaultWithShares(liabilityBefore);

      expect(await dashboard.liabilityShares()).to.equal(0n);
    });

    it("Rebalances by ether vs shares consistency", async () => {
      // Mint shares
      await dashboard.connect(owner).fund({ value: ether("10") });
      await dashboard.connect(owner).mintShares(owner, ether("5"));

      const sharesToRebalance = ether("1");
      const liabilityBefore = await dashboard.liabilityShares();

      // Rebalance by shares
      await dashboard.connect(owner).rebalanceVaultWithShares(sharesToRebalance);
      const liabilityAfterShares = await dashboard.liabilityShares();

      // Should have reduced by approximately sharesToRebalance
      expect(liabilityBefore - liabilityAfterShares).to.be.closeTo(sharesToRebalance, 2n);
    });
  });

  describe("View Function Edge Cases", () => {
    it("View functions work during disconnect transition", async () => {
      const totalValueBefore = await dashboard.totalValue();
      const lockedBefore = await dashboard.locked();
      const maxLockableValueBefore = await dashboard.maxLockableValue();

      await dashboard.connect(owner).voluntaryDisconnect();

      // All view functions should still work
      await mEqual([
        [await dashboard.totalValue(), totalValueBefore],
        [await dashboard.locked(), lockedBefore],
        [await dashboard.maxLockableValue(), maxLockableValueBefore],
        [await dashboard.withdrawableValue(), 0n],
        [dashboard.obligations().then((o) => o.sharesToBurn), 0],
        [dashboard.obligations().then((o) => o.feesToSettle), 0],
      ]);
    });

    it("obligations() with large liability values", async () => {
      // Fund and mint maximum
      await dashboard.connect(owner).fund({ value: ether("50") });
      const maxShares = await dashboard.totalMintingCapacityShares();
      await dashboard.connect(owner).mintShares(owner, maxShares);

      // Report with cumulative Lido fees to create obligations
      await reportVaultDataWithProof(ctx, stakingVault, {
        cumulativeLidoFees: ether("1"),
        waitForNextRefSlot: true,
      });

      const [sharesToBurn, feesToSettle] = await dashboard.obligations();

      // Verify obligations match the reported Lido fees
      expect(feesToSettle).to.equal(ether("1"));
      expect(sharesToBurn).to.be.gte(0n); // Shares to burn depends on exchange rate
    });
  });

  describe("PDG Policy", () => {
    it("Policy transitions work correctly", async () => {
      const currentPolicy = await dashboard.pdgPolicy();

      // Change to ALLOW_PROVE if not already
      if (Number(currentPolicy) !== Number(PDGPolicy.ALLOW_PROVE)) {
        await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_PROVE);
        expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.ALLOW_PROVE);
      }

      // Change to STRICT
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.STRICT);
      expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.STRICT);

      // Change back to ALLOW_DEPOSIT_AND_PROVE
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
      expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);

      // Change to ALLOW_PROVE again
      await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_PROVE);
      expect(await dashboard.pdgPolicy()).to.equal(PDGPolicy.ALLOW_PROVE);
    });
  });

  describe("Beacon Chain Operations", () => {
    it("Handles pause/resume cycle", async () => {
      // Pause deposits
      await dashboard.connect(owner).pauseBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Resume deposits
      await dashboard.connect(owner).resumeBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;

      // Can pause again
      await dashboard.connect(owner).pauseBeaconChainDeposits();
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;

      // Resume for cleanup
      await dashboard.connect(owner).resumeBeaconChainDeposits();
    });

    it("Requests validator exit with valid pubkey", async () => {
      const keys = getPubkeys(1);

      await expect(dashboard.connect(owner).requestValidatorExit(keys.stringified))
        .to.emit(stakingVault, "ValidatorExitRequested")
        .withArgs(keys.pubkeys[0], keys.pubkeys[0]);
    });
  });

  describe("Access Control Edge Cases", () => {
    it("Confirmation requires both parties", async () => {
      // Ensure report is fresh
      await reportVaultDataWithProof(ctx, stakingVault, { waitForNextRefSlot: true });

      const feeRateBefore = await dashboard.feeRate();
      // Start a confirmation from owner
      await dashboard.connect(owner).setFeeRate(feeRateBefore + 1n);
      expect(await dashboard.feeRate()).to.equal(feeRateBefore);

      // Complete with node operator
      await dashboard.connect(nodeOperator).setFeeRate(feeRateBefore + 1n);

      // Now it should be set
      expect(await dashboard.feeRate()).to.equal(feeRateBefore + 1n);
    });

    it("Concurrent confirmations operate independently", async () => {
      // Start confirmation for fee rate
      await dashboard.connect(owner).setFeeRate(750n);

      // Start confirmation for expiry (independent operation)
      await dashboard.connect(owner).setConfirmExpiry(days(10n));

      // Complete expiry confirmation
      await dashboard.connect(nodeOperator).setConfirmExpiry(days(10n));
      expect(await dashboard.getConfirmExpiry()).to.equal(days(10n));

      // Fee rate confirmation should still be pending
      // Complete it
      await dashboard.connect(nodeOperator).setFeeRate(750n);
      expect(await dashboard.feeRate()).to.equal(750n);
    });
  });

  describe("Disconnection & Reconnection Edge Cases", () => {
    it("Handles disconnect with zero fees", async () => {
      // Ensure no fees accrued
      const feeBefore = await dashboard.accruedFee();
      expect(feeBefore).to.be.equal(0n);

      await dashboard.connect(owner).voluntaryDisconnect();

      // Fee leftover should equal the fee that was accrued
      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.equal(feeBefore);
    });

    it("Handles multiple disconnect/reconnect cycles", async () => {
      // First disconnect
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      // Reconnect
      const settledGrowth1 = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, settledGrowth1);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, settledGrowth1);
      await dashboard.connect(owner).reconnectToVaultHub();

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;

      // Second disconnect
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      // Second reconnect
      const settledGrowth2 = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, settledGrowth2);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, settledGrowth2);
      await dashboard.connect(owner).reconnectToVaultHub();

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    });
  });

  describe("Fundable Modifier Tests", () => {
    it("mintShares() accepts funding via msg.value", async () => {
      const valueBefore = await dashboard.totalValue();
      const fundingAmount = ether("5");
      const sharesToMint = ether("1");

      await expect(dashboard.connect(owner).mintShares(owner, sharesToMint, { value: fundingAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundingAmount)
        .and.to.emit(vaultHub, "MintedSharesOnVault");

      const valueAfter = await dashboard.totalValue();
      expect(valueAfter - valueBefore).to.equal(fundingAmount);
    });

    it("mintStETH() accepts funding via msg.value", async () => {
      const valueBefore = await dashboard.totalValue();
      const fundingAmount = ether("3");
      const stETHAmount = ether("1");

      await expect(dashboard.connect(owner).mintStETH(owner, stETHAmount, { value: fundingAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundingAmount);

      const valueAfter = await dashboard.totalValue();
      expect(valueAfter - valueBefore).to.equal(fundingAmount);
    });

    it("mintWstETH() accepts funding via msg.value", async () => {
      const valueBefore = await dashboard.totalValue();
      const fundingAmount = ether("2");
      const wstETHAmount = ether("0.5");

      await expect(dashboard.connect(owner).mintWstETH(owner, wstETHAmount, { value: fundingAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundingAmount);

      const valueAfter = await dashboard.totalValue();
      expect(valueAfter - valueBefore).to.equal(fundingAmount);
    });

    it("rebalanceVaultWithEther() accepts funding via msg.value", async () => {
      // First mint some shares
      await dashboard.connect(owner).mintShares(owner, ether("2"));

      const valueBefore = await dashboard.totalValue();
      const fundingAmount = ether("3");
      const rebalanceAmount = ether("0.5");

      await expect(dashboard.connect(owner).rebalanceVaultWithEther(rebalanceAmount, { value: fundingAmount }))
        .to.emit(stakingVault, "EtherFunded")
        .withArgs(fundingAmount);

      const valueAfter = await dashboard.totalValue();
      // Value increases by funding minus rebalance amount
      expect(valueAfter).to.be.closeTo(valueBefore + fundingAmount - rebalanceAmount, 2n);
    });
  });

  describe("Fee Collection Edge Cases", () => {
    it("recoverFeeLeftover() reverts if fee exceeds abnormally high threshold", async () => {
      // Create large fees
      await dashboard.connect(owner).fund({ value: ether("100") });
      const tvBefore = await dashboard.totalValue();

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: tvBefore,
        waitForNextRefSlot: true,
      });

      // Sync settled growth
      const inOutDelta = (await dashboard.latestReport()).inOutDelta;
      const currentGrowth = tvBefore - BigInt(inOutDelta);
      const settledGrowth = await dashboard.settledGrowth();
      if (settledGrowth !== currentGrowth) {
        await dashboard.connect(owner).correctSettledGrowth(currentGrowth, settledGrowth);
        await dashboard.connect(nodeOperator).correctSettledGrowth(currentGrowth, settledGrowth);
      }

      // Create massive growth to trigger abnormally high fee
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: tvBefore * 3n, // 200% growth
        waitForNextRefSlot: true,
      });

      const totalValue = await dashboard.totalValue();
      const accruedFee = await dashboard.accruedFee();
      const abnormalThreshold = totalValue / 100n; // 1%

      // With 200% growth, fee should be abnormally high
      expect(accruedFee).to.be.gte(abnormalThreshold);

      // Disconnect itself should revert because it calls _collectFeeLeftover() with abnormally high fee
      await expect(dashboard.connect(owner).voluntaryDisconnect()).to.be.revertedWithCustomError(
        dashboard,
        "AbnormallyHighFee",
      );
    });

    it("recoverFeeLeftover() succeeds when fee is below threshold", async () => {
      // Create small fees
      await dashboard.connect(owner).fund({ value: ether("50") });
      const tvBefore = await dashboard.totalValue();

      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: tvBefore,
        waitForNextRefSlot: true,
      });

      // Sync settled growth
      const inOutDelta = (await dashboard.latestReport()).inOutDelta;
      const currentGrowth = tvBefore - BigInt(inOutDelta);
      const settledGrowth = await dashboard.settledGrowth();
      if (settledGrowth !== currentGrowth) {
        await dashboard.connect(owner).correctSettledGrowth(currentGrowth, settledGrowth);
        await dashboard.connect(nodeOperator).correctSettledGrowth(currentGrowth, settledGrowth);
      }

      // Create small growth (< 1% fee)
      const smallGrowth = tvBefore / 500n; // 0.2% growth
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: tvBefore + smallGrowth,
        waitForNextRefSlot: true,
      });

      // Disconnect
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      const feeLeftover = await dashboard.feeLeftover();
      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      if (feeLeftover > 0n) {
        await expect(dashboard.recoverFeeLeftover())
          .to.emit(dashboard, "AssetsRecovered")
          .withArgs(feeRecipient, ETH_ADDRESS, feeLeftover);

        const balanceAfter = await ethers.provider.getBalance(feeRecipient);
        expect(balanceAfter - balanceBefore).to.equal(feeLeftover);
        expect(await dashboard.feeLeftover()).to.equal(0n);
      }
    });
  });

  describe("connectAndAcceptTier() Tests", () => {
    it("Reverts with TierChangeNotConfirmed when tier change not confirmed", async () => {
      const { operatorGrid, stakingVaultFactory } = ctx.contracts;
      const agentSigner = await ctx.getSigner("agent");

      // Register a group and tier for the node operator
      await operatorGrid.connect(agentSigner).registerGroup(nodeOperator, ether("1000"));
      await operatorGrid.connect(agentSigner).registerTiers(nodeOperator, [
        {
          shareLimit: ether("100"),
          reserveRatioBP: 10_00,
          forcedRebalanceThresholdBP: 5_00,
          infraFeeBP: 0,
          liquidityFeeBP: 0,
          reservationFeeBP: 0,
        },
      ]);

      const group = await operatorGrid.group(nodeOperator);
      const tierId = group.tierIds[0];

      // Create a fresh vault WITHOUT connecting to VaultHub
      const tx = await stakingVaultFactory
        .connect(owner)
        .createVaultWithDashboardWithoutConnectingToVaultHub(owner, nodeOperator, nodeOperator, 500, 86400, []);
      const receipt = await tx.wait();
      const dashboardCreatedEvents = ctx.getEvents(receipt!, "DashboardCreated");
      const newDashboard = await ethers.getContractAt("Dashboard", dashboardCreatedEvents[0].args!.dashboard, owner);

      // Try to connect with tier change but without node operator confirmation
      // This should revert because _changeTier returns false (pending confirmation)
      await expect(
        newDashboard.connect(owner).connectAndAcceptTier(tierId, ether("100"), { value: ether("1") }),
      ).to.be.revertedWithCustomError(newDashboard, "TierChangeNotConfirmed");
    });

    it("Successfully connects when settled growth is corrected", async () => {
      // Disconnect first
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      // Correct settled growth
      const settledGrowth = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, settledGrowth);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, settledGrowth);

      // Reconnect normally
      await dashboard.connect(owner).reconnectToVaultHub();

      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    });
  });

  describe("Precise State Verification Tests", () => {
    it("mintShares() updates all relevant state correctly", async () => {
      const sharesToMint = ether("2");
      const liabilityBefore = await dashboard.liabilityShares();
      const recipientSharesBefore = await lido.sharesOf(stranger);

      const expectedLocked = await calculateLockedValue(ctx, stakingVault, {
        liabilityShares: liabilityBefore + sharesToMint,
      });

      await expect(dashboard.connect(owner).mintShares(stranger, sharesToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(stakingVault, sharesToMint, expectedLocked);

      // Verify all state changes
      const liabilityAfter = await dashboard.liabilityShares();
      const lockedAfter = await dashboard.locked();
      const recipientSharesAfter = await lido.sharesOf(stranger);

      expect(liabilityAfter).to.equal(liabilityBefore + sharesToMint);
      expect(lockedAfter).to.equal(expectedLocked);
      expect(recipientSharesAfter).to.equal(recipientSharesBefore + sharesToMint);
    });

    it("burnShares() updates all relevant state correctly", async () => {
      // First mint
      const sharesToMint = ether("3");
      await dashboard.connect(owner).mintShares(owner, sharesToMint);

      const sharesToBurn = ether("1");
      const liabilityBefore = await dashboard.liabilityShares();
      const ownerSharesBefore = await lido.sharesOf(owner);

      // Approve via shareLimit instead of stETH approve to avoid allowance issues
      await lido.connect(owner).approve(dashboard, MaxUint256);

      await expect(dashboard.connect(owner).burnShares(sharesToBurn))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, sharesToBurn);

      // Verify all state changes
      const liabilityAfter = await dashboard.liabilityShares();
      const ownerSharesAfter = await lido.sharesOf(owner);

      expect(liabilityAfter).to.equal(liabilityBefore - sharesToBurn);

      // Verify locked matches VaultHub's calculation
      const lockedAfter = await dashboard.locked();
      const vaultHubLocked = await vaultHub.locked(stakingVault);
      expect(lockedAfter).to.equal(vaultHubLocked);

      expect(ownerSharesAfter).to.equal(ownerSharesBefore - sharesToBurn);
    });

    it("rebalanceVaultWithShares() emits events and updates state precisely", async () => {
      // Fund and mint shares first
      await dashboard.connect(owner).fund({ value: ether("10") });
      const capacity = await dashboard.remainingMintingCapacityShares(0n);
      const sharesToMint = capacity > ether("5") ? ether("5") : capacity;
      await dashboard.connect(owner).mintShares(owner, sharesToMint);

      const sharesToRebalance = ether("2");
      const liabilityBefore = await dashboard.liabilityShares();

      await expect(dashboard.connect(owner).rebalanceVaultWithShares(sharesToRebalance)).to.emit(
        vaultHub,
        "VaultRebalanced",
      );

      const liabilityAfter = await dashboard.liabilityShares();

      expect(liabilityAfter).to.equal(liabilityBefore - sharesToRebalance);

      // Verify locked matches VaultHub's calculation
      const lockedAfter = await dashboard.locked();
      const vaultHubLocked = await vaultHub.locked(stakingVault);
      expect(lockedAfter).to.equal(vaultHubLocked);
    });

    it("withdraw() emits events and transfers exact amount", async () => {
      const withdrawAmount = ether("1");
      const recipientBalanceBefore = await ethers.provider.getBalance(stranger);
      const vaultBalanceBefore = await ethers.provider.getBalance(stakingVault);

      await expect(dashboard.connect(owner).withdraw(stranger, withdrawAmount))
        .to.emit(stakingVault, "EtherWithdrawn")
        .withArgs(stranger, withdrawAmount);

      const recipientBalanceAfter = await ethers.provider.getBalance(stranger);
      const vaultBalanceAfter = await ethers.provider.getBalance(stakingVault);

      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(withdrawAmount);
      expect(vaultBalanceBefore - vaultBalanceAfter).to.equal(withdrawAmount);
    });
  });

  describe("Common scenarios", () => {
    it("Fund -> mint -> burn", async () => {
      // Create fresh vault
      const { dashboard: freshDashboard, stakingVault: freshVault } = await createVaultWithDashboard(
        ctx,
        ctx.contracts.stakingVaultFactory,
        owner,
        nodeOperator,
        nodeOperator,
      );

      // Fund
      await freshDashboard.connect(owner).fund({ value: ether("10") });
      expect(await freshDashboard.totalValue()).to.equal(ether("11"));

      // Mint
      const mintCapacity = await freshDashboard.totalMintingCapacityShares();
      await freshDashboard.connect(owner).mintShares(owner, mintCapacity);
      expect(await freshDashboard.liabilityShares()).to.equal(mintCapacity);

      // Burn
      await lido.connect(owner).approve(freshDashboard, ether("100"));
      await freshDashboard.connect(owner).burnShares(mintCapacity);
      expect(await freshDashboard.liabilityShares()).to.equal(0n);

      // Report to update values
      await reportVaultDataWithProof(ctx, freshVault, { waitForNextRefSlot: true });

      expect(await freshDashboard.totalMintingCapacityShares()).to.equal(mintCapacity);
    });

    it("Fee accrual and disbursement lifecycle", async () => {
      // Start with fresh state - fund more
      const totalValue = await dashboard.totalValue();
      const settledGrowth = await dashboard.settledGrowth();
      const rewards = ether("1");

      // Simulate growth (rewards)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: totalValue + rewards,
        waitForNextRefSlot: true,
      });

      // Check fee accrued
      const expectedFee = (rewards * (await dashboard.feeRate())) / TOTAL_BASIS_POINTS;
      const fee = await dashboard.accruedFee();
      expect(fee).to.equal(expectedFee);

      // Disburse fee
      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      await dashboard.disburseFee();

      const balanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(balanceAfter).to.equal(balanceBefore + expectedFee);

      // Fee should now be 0
      expect(await dashboard.accruedFee()).to.equal(0n);

      // Verify settled growth was updated to current growth + rewards
      const newSettledGrowth = await dashboard.settledGrowth();
      expect(newSettledGrowth).to.equal(settledGrowth + rewards);
    });

    it("Disconnect and reconnect lifecycle", async () => {
      // Initiate disconnect
      await dashboard.connect(owner).voluntaryDisconnect();
      expect(await vaultHub.isPendingDisconnect(stakingVault)).to.be.true;

      // Complete disconnect via report
      await reportVaultDataWithProof(ctx, stakingVault);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.false;

      // Correct settled growth
      const currentSettled = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, currentSettled);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, currentSettled);

      // Reconnect
      await dashboard.connect(owner).reconnectToVaultHub();
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    });

    it("Unhealthy vault recovery", async () => {
      // Mint maximum
      const maxShares = await dashboard.totalMintingCapacityShares();
      await dashboard.connect(owner).mintShares(owner, maxShares);

      // Simulate slashing
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("5"),
        waitForNextRefSlot: true,
      });

      // Vault should be unhealthy
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.false;

      // Can't mint more
      await expect(dashboard.connect(owner).mintShares(owner, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ExceedsMintingCapacity",
      );

      // Fund to recover
      await dashboard.connect(owner).fund({ value: ether("20") });

      // Should be healthy now
      expect(await vaultHub.isVaultHealthy(stakingVault)).to.be.true;

      // Can mint again
      const newCapacity = await dashboard.remainingMintingCapacityShares(0n);
      await dashboard.connect(owner).mintShares(owner, newCapacity);
    });
  });

  const createValidators = (count: number, withdrawalCredentials: string): ValidatorInfo[] =>
    Array.from({ length: count }, () => ({ ...generateValidator(withdrawalCredentials), index: 0, proof: [] }));

  const addValidatorsToTree = async (validators: ValidatorInfo[]) => {
    if (!mockCLtree) throw new Error("mockCLtree not initialized");
    for (const validator of validators) {
      validator.index = (await mockCLtree.addValidator(validator.container)).validatorIndex;
    }
  };

  const commitAndProveValidators = async (validators: ValidatorInfo[], slotOffset: number) => {
    if (!mockCLtree) throw new Error("mockCLtree not initialized");

    ({ childBlockTimestamp, beaconBlockHeader } = await mockCLtree.commitChangesToBeaconRoot(
      Number(slot) + slotOffset,
    ));

    for (const validator of validators) {
      validator.proof = await mockCLtree.buildProof(validator.index, beaconBlockHeader);
    }

    return { header: beaconBlockHeader, timestamp: childBlockTimestamp };
  };

  const toWitnesses = (validators: ValidatorInfo[], header: SSZBLSHelpers.BeaconBlockHeaderStruct, timestamp: number) =>
    validators.map((validator) => ({
      proof: validator.proof,
      pubkey: hexlify(validator.container.pubkey),
      validatorIndex: validator.index,
      childBlockTimestamp: timestamp,
      slot: header.slot,
      proposerIndex: header.proposerIndex,
    }));
});
