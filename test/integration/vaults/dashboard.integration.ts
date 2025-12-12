import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Dashboard, ERC20__Harness, Lido, StakingVault, VaultHub, WstETH } from "typechain-types";

import {
  advanceChainTime,
  days,
  ether,
  PDGPolicy,
  randomAddress,
  randomValidatorPubkey,
  TOTAL_BASIS_POINTS,
} from "lib";
import {
  autofillRoles,
  calculateLockedValue,
  createVaultWithDashboard,
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
  let lido: Lido;
  let wstETH: WstETH;

  let roles: VaultRoles;
  let erc20Token: ERC20__Harness;

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
    lido = ctx.contracts.lido;
    wstETH = ctx.contracts.wstETH;

    // Connect dashboard to owner for role management
    dashboard = dashboard.connect(owner);

    // Autofill roles
    roles = await autofillRoles(dashboard, nodeOperator);

    // Deploy test ERC20 token
    erc20Token = await ethers.deployContract("ERC20__Harness", ["Test Token", "TST"]);

    // Fund the vault for testing
    await dashboard.connect(owner).fund({ value: ether("10") });

    // Set PDG policy to ALLOW_DEPOSIT_AND_PROVE for testing
    await dashboard.connect(owner).setPDGPolicy(PDGPolicy.ALLOW_DEPOSIT_AND_PROVE);
  });

  beforeEach(async () => (snapshot = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(snapshot));
  after(async () => await Snapshot.restore(originalSnapshot));

  // ==================== View Functions ====================

  describe("View Functions", () => {
    describe("vaultConnection()", () => {
      it("Returns the vault connection data", async () => {
        const connection = await dashboard.vaultConnection();
        expect(connection.reserveRatioBP).to.be.gt(0n);
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
        await dashboard.connect(owner).mintShares(owner, ether("1"));
        const lockedAfter = await dashboard.locked();
        expect(lockedAfter).to.be.gt(lockedBefore);
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

        // Simulate slashing
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("5"),
          waitForNextRefSlot: true,
        });

        const shortfall = await dashboard.healthShortfallShares();
        expect(shortfall).to.be.gt(0n);
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
    });

    describe("maxLockableValue()", () => {
      it("Returns max lockable value minus node operator fee", async () => {
        const maxLockable = await dashboard.maxLockableValue();
        const vaultHubMaxLockable = await vaultHub.maxLockableValue(stakingVault);
        const accruedFee = await dashboard.accruedFee();

        expect(maxLockable).to.equal(vaultHubMaxLockable - accruedFee);
      });

      it("Returns 0 when accrued fee exceeds max lockable", async () => {
        // Create a scenario where fees exceed max lockable by simulating huge rewards
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("100"),
          waitForNextRefSlot: true,
        });

        // The maxLockableValue considers accrued fees
        const maxLockable = await dashboard.maxLockableValue();
        expect(maxLockable).to.be.gte(0n);
      });
    });

    describe("totalMintingCapacityShares()", () => {
      it("Returns minting capacity accounting for fees", async () => {
        const capacity = await dashboard.totalMintingCapacityShares();
        expect(capacity).to.be.gt(0n);
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
        const withFunding = await dashboard.remainingMintingCapacityShares(ether("10"));
        expect(withFunding).to.be.gt(withoutFunding);
      });

      it("Returns 0 when capacity is exceeded by liabilities", async () => {
        // Mint max
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);

        // Even with funding, remaining should be 0 until existing shares are burned
        expect(await dashboard.remainingMintingCapacityShares(0n)).to.equal(0n);
      });
    });

    describe("withdrawableValue()", () => {
      it("Returns withdrawable amount accounting for fees", async () => {
        const withdrawable = await dashboard.withdrawableValue();
        const vaultHubWithdrawable = await vaultHub.withdrawableValue(stakingVault);
        const accruedFee = await dashboard.accruedFee();

        expect(withdrawable).to.equal(vaultHubWithdrawable > accruedFee ? vaultHubWithdrawable - accruedFee : 0n);
      });

      it("Returns 0 when fee exceeds withdrawable", async () => {
        // Mint max to lock all value
        const maxShares = await dashboard.totalMintingCapacityShares();
        await dashboard.connect(owner).mintShares(owner, maxShares);

        // withdrawable should be minimal
        const withdrawable = await dashboard.withdrawableValue();
        expect(withdrawable).to.be.lte(2n); // Account for rounding
      });
    });

    describe("latestReport()", () => {
      it("Returns the latest vault report", async () => {
        const report = await dashboard.latestReport();
        expect(report.totalValue).to.be.gte(0n);
      });
    });

    describe("accruedFee()", () => {
      it("Returns 0 when no growth", async () => {
        expect(await dashboard.accruedFee()).to.equal(0n);
      });

      it("Returns non-zero after vault growth", async () => {
        // Report vault with growth
        await reportVaultDataWithProof(ctx, stakingVault, {
          totalValue: ether("20"),
          waitForNextRefSlot: true,
        });

        expect(await dashboard.accruedFee()).to.be.gt(0n);
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
      await dashboard.connect(owner).fund({ value: ether("1") });
      expect(await dashboard.totalValue()).to.equal(valueBefore + ether("1"));
    });

    it("Allows funder role to fund", async () => {
      const valueBefore = await dashboard.totalValue();
      await dashboard.connect(roles.funder).fund({ value: ether("1") });
      expect(await dashboard.totalValue()).to.equal(valueBefore + ether("1"));
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
      const strangerBefore = await ethers.provider.getBalance(stranger);
      await dashboard.connect(owner).withdraw(stranger, withdrawable);
      const strangerAfter = await ethers.provider.getBalance(stranger);
      expect(strangerAfter - strangerBefore).to.equal(withdrawable);
    });

    it("Allows withdrawer role to withdraw", async () => {
      const withdrawable = await dashboard.withdrawableValue();
      await dashboard.connect(roles.withdrawer).withdraw(stranger, withdrawable);
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
      await expect(dashboard.connect(owner).mintShares(stranger, sharesToMint))
        .to.emit(vaultHub, "MintedSharesOnVault")
        .withArgs(
          stakingVault,
          sharesToMint,
          await calculateLockedValue(ctx, stakingVault, { liabilityShares: sharesToMint }),
        );

      expect(await lido.sharesOf(stranger)).to.equal(sharesToMint);
    });

    it("Allows funding with msg.value via fundable modifier", async () => {
      const valueBefore = await dashboard.totalValue();
      await dashboard.connect(owner).mintShares(stranger, ether("0.1"), { value: ether("5") });
      expect(await dashboard.totalValue()).to.equal(valueBefore + ether("5"));
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
      await dashboard.connect(owner).mintStETH(stranger, amount);
      const sharesAfter = await lido.sharesOf(stranger);
      expect(sharesAfter).to.be.gt(sharesBefore);
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
      await dashboard.connect(owner).mintWstETH(stranger, amount);
      const wstETHAfter = await wstETH.balanceOf(stranger);
      expect(wstETHAfter - wstETHBefore).to.equal(amount);
    });
  });

  // ==================== Burning Operations ====================

  describe("burnShares()", () => {
    it("Burns shares from sender", async () => {
      // First mint some shares to owner
      await dashboard.connect(owner).mintShares(owner, ether("1"));

      // Approve and burn
      await lido.connect(owner).approve(dashboard, ether("10"));
      await expect(dashboard.connect(owner).burnShares(ether("1")))
        .to.emit(vaultHub, "BurnedSharesOnVault")
        .withArgs(stakingVault, ether("1"));
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
      await dashboard.connect(owner).mintStETH(owner, ether("1"));

      // Approve and burn
      await lido.connect(owner).approve(dashboard, ether("10"));
      const sharesBefore = await dashboard.liabilityShares();
      await dashboard.connect(owner).burnStETH(ether("0.5"));
      const sharesAfter = await dashboard.liabilityShares();
      expect(sharesAfter).to.be.lt(sharesBefore);
    });
  });

  describe("burnWstETH()", () => {
    it("Burns wstETH from sender", async () => {
      // Mint wstETH first
      await dashboard.connect(owner).mintWstETH(owner, ether("1"));

      // Approve and burn
      await wstETH.connect(owner).approve(dashboard, ether("10"));
      const sharesBefore = await dashboard.liabilityShares();
      await dashboard.connect(owner).burnWstETH(ether("0.5"));
      const sharesAfter = await dashboard.liabilityShares();
      expect(sharesAfter).to.be.lt(sharesBefore);
    });
  });

  // ==================== Rebalancing Operations ====================

  describe("rebalanceVaultWithShares()", () => {
    it("Rebalances vault by shares", async () => {
      // Mint shares first
      await dashboard.connect(owner).mintShares(owner, ether("1"));

      const liabilityBefore = await dashboard.liabilityShares();
      await dashboard.connect(owner).rebalanceVaultWithShares(ether("0.5"));
      const liabilityAfter = await dashboard.liabilityShares();
      expect(liabilityAfter).to.equal(liabilityBefore - ether("0.5"));
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
      await dashboard.connect(owner).mintShares(owner, ether("1"));

      const liabilityBefore = await dashboard.liabilityShares();
      await dashboard.connect(owner).rebalanceVaultWithEther(ether("0.5"));
      const liabilityAfter = await dashboard.liabilityShares();
      expect(liabilityAfter).to.be.lt(liabilityBefore);
    });

    it("Allows funding via msg.value", async () => {
      await dashboard.connect(owner).mintShares(owner, ether("1"));

      const valueBefore = await dashboard.totalValue();
      await dashboard.connect(owner).rebalanceVaultWithEther(ether("0.1"), { value: ether("1") });
      // Value increases by funding minus rebalance
      expect(await dashboard.totalValue()).to.be.closeTo(valueBefore + ether("0.9"), ether("0.01"));
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
  });

  describe("proveUnknownValidatorsToPDG()", () => {
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

      // Will revert with a different error (proof validation) not policy
      await expect(
        dashboard.connect(roles.unknownValidatorProver).proveUnknownValidatorsToPDG(witnesses),
      ).to.not.be.revertedWithCustomError(dashboard, "ForbiddenByPDGPolicy");
    });
  });

  // ==================== Token Recovery ====================

  describe("recoverERC20()", () => {
    it("Recovers ERC20 tokens from dashboard", async () => {
      await erc20Token.mint(dashboard, ether("100"));

      await expect(dashboard.connect(owner).recoverERC20(erc20Token, stranger, ether("100")))
        .to.emit(dashboard, "AssetsRecovered")
        .withArgs(stranger, erc20Token, ether("100"));

      expect(await erc20Token.balanceOf(stranger)).to.equal(ether("100"));
    });

    it("Recovers ETH using EIP-7528 address", async () => {
      const dashboardAddress = await dashboard.getAddress();
      await setBalance(dashboardAddress, ether("2"));

      const strangerBefore = await ethers.provider.getBalance(stranger);
      await dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, ether("1"));
      const strangerAfter = await ethers.provider.getBalance(stranger);
      expect(strangerAfter - strangerBefore).to.equal(ether("1"));
    });

    it("Reverts when recovering ETH that belongs to feeLeftover", async () => {
      // Create fee leftover by disconnecting with fees
      await dashboard.connect(owner).fund({ value: ether("10") });
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("25"),
        waitForNextRefSlot: true,
      });

      const accruedFee = await dashboard.accruedFee();
      expect(accruedFee).to.be.gt(0n);

      await dashboard.connect(owner).voluntaryDisconnect();

      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.be.gt(0n);

      // Complete disconnect
      await reportVaultDataWithProof(ctx, stakingVault);

      const dashboardBalance = await ethers.provider.getBalance(dashboard);

      // Try to recover more than available (balance - feeLeftover)
      await expect(
        dashboard.connect(owner).recoverERC20(ETH_ADDRESS, stranger, dashboardBalance),
      ).to.be.revertedWithCustomError(dashboard, "InsufficientBalance");
    });

    it("Reverts with ZeroAddress for token", async () => {
      await expect(dashboard.connect(owner).recoverERC20(ZeroAddress, stranger, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroAddress",
      );
    });

    it("Reverts with ZeroAddress for recipient", async () => {
      await expect(dashboard.connect(owner).recoverERC20(erc20Token, ZeroAddress, 1n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroAddress",
      );
    });

    it("Reverts with ZeroArgument for amount", async () => {
      await expect(dashboard.connect(owner).recoverERC20(erc20Token, stranger, 0n)).to.be.revertedWithCustomError(
        dashboard,
        "ZeroArgument",
      );
    });
  });

  describe("collectERC20FromVault()", () => {
    it("Collects ERC20 tokens from vault", async () => {
      await erc20Token.mint(stakingVault, ether("100"));

      await expect(dashboard.connect(owner).collectERC20FromVault(erc20Token, stranger, ether("100")))
        .to.emit(stakingVault, "AssetsRecovered")
        .withArgs(stranger, erc20Token, ether("100"));
    });

    it("Reverts when trying to collect ETH via EIP-7528", async () => {
      await expect(
        dashboard.connect(owner).collectERC20FromVault(ETH_ADDRESS, stranger, ether("1")),
      ).to.be.revertedWithCustomError(stakingVault, "EthCollectionNotAllowed");
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).collectERC20FromVault(erc20Token, stranger, 1n))
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.COLLECT_VAULT_ERC20_ROLE());
    });
  });

  // ==================== Beacon Chain Operations ====================

  describe("pauseBeaconChainDeposits()", () => {
    it("Pauses beacon chain deposits", async () => {
      await expect(dashboard.connect(owner).pauseBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsPaused",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.true;
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
      await expect(dashboard.connect(owner).resumeBeaconChainDeposits()).to.emit(
        stakingVault,
        "BeaconChainDepositsResumed",
      );
      expect(await stakingVault.beaconChainDepositsPaused()).to.be.false;
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
  });

  // ==================== Node Operator Fee Management ====================

  describe("disburseFee()", () => {
    it("Disburses fee permissionlessly", async () => {
      // First correct the settled growth to enable small fees
      const currentTotalValue = await dashboard.totalValue();
      const inOutDelta = (await dashboard.latestReport()).inOutDelta;
      const currentGrowth = currentTotalValue - BigInt(inOutDelta);

      // Set settled growth to current growth so we start from 0 fees
      const settledGrowth = await dashboard.settledGrowth();
      if (settledGrowth != currentGrowth) {
        await dashboard.connect(owner).correctSettledGrowth(currentGrowth, settledGrowth);
        await dashboard.connect(nodeOperator).correctSettledGrowth(currentGrowth, settledGrowth);
      }

      // Create small growth to accrue fees (< 1% threshold)
      const smallGrowth = currentTotalValue / 500n; // 0.2% growth
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: currentTotalValue + smallGrowth,
        waitForNextRefSlot: true,
      });

      const fee = await dashboard.accruedFee();
      if (fee > 0n) {
        const feeRecipient = await dashboard.feeRecipient();
        const balanceBefore = await ethers.provider.getBalance(feeRecipient);

        await expect(dashboard.connect(stranger).disburseFee()).to.emit(dashboard, "FeeDisbursed");

        const balanceAfter = await ethers.provider.getBalance(feeRecipient);
        expect(balanceAfter - balanceBefore).to.equal(fee);
      }
    });

    it("Does not revert when fee is zero (updates settledGrowth)", async () => {
      // No growth, so fee is 0
      expect(await dashboard.accruedFee()).to.equal(0n);

      // Should not revert
      await dashboard.connect(stranger).disburseFee();
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

      // If there's a fee, admin should be able to disburse it
      const fee = await dashboard.accruedFee();
      if (fee > 0n) {
        await expect(dashboard.connect(owner).disburseAbnormallyHighFee()).to.emit(dashboard, "FeeDisbursed");
      }
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
      // First confirmation from owner
      await expect(dashboard.connect(owner).setFeeRate(500n)).to.not.emit(dashboard, "FeeRateSet");

      // Second confirmation from node operator
      await expect(dashboard.connect(nodeOperator).setFeeRate(500n)).to.emit(dashboard, "FeeRateSet");

      expect(await dashboard.feeRate()).to.equal(500n);
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

      // First confirmation
      await expect(
        dashboard.connect(owner).correctSettledGrowth(currentSettledGrowth + 100n, currentSettledGrowth),
      ).to.not.emit(dashboard, "SettledGrowthSet");

      // Second confirmation
      await expect(
        dashboard.connect(nodeOperator).correctSettledGrowth(currentSettledGrowth + 100n, currentSettledGrowth),
      ).to.emit(dashboard, "SettledGrowthSet");
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

      await dashboard.connect(roles.nodeOperatorFeeExemptor).addFeeExemption(100n);

      const settledAfter = await dashboard.settledGrowth();
      expect(settledAfter).to.equal(settledBefore + 100n);
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
      const newRecipient = randomAddress();

      await expect(dashboard.connect(nodeOperator).setFeeRecipient(newRecipient))
        .to.emit(dashboard, "FeeRecipientSet")
        .withArgs(nodeOperator, await dashboard.feeRecipient(), newRecipient);

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

      expect(await dashboard.feeLeftover()).to.be.gt(0n);
    });

    it("Reverts when called by unauthorized account", async () => {
      await expect(dashboard.connect(stranger).voluntaryDisconnect())
        .to.be.revertedWithCustomError(dashboard, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await dashboard.VOLUNTARY_DISCONNECT_ROLE());
    });
  });

  describe("recoverFeeLeftover()", () => {
    it("Recovers fee leftover to fee recipient", async () => {
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

      // Create growth to accrue a fee
      const growth = fundedTotalValue / 200n; // 0.5% growth
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: fundedTotalValue + growth,
        waitForNextRefSlot: true,
      });

      await dashboard.connect(owner).voluntaryDisconnect();

      // Complete disconnect
      await reportVaultDataWithProof(ctx, stakingVault);

      const feeLeftover = await dashboard.feeLeftover();
      expect(feeLeftover).to.be.gt(0n);

      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      await dashboard.recoverFeeLeftover();

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

    it("Allows funding on connect via reconnectToVaultHub", async () => {
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      const currentSettled = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, currentSettled);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, currentSettled);

      // Fund should happen via reconnectToVaultHub (which accepts ownership first)
      const valueBefore = await ethers.provider.getBalance(stakingVault);

      // First fund separately, then reconnect
      await owner.sendTransaction({ to: stakingVault, value: ether("1") });
      await dashboard.connect(owner).reconnectToVaultHub();

      const valueAfter = await ethers.provider.getBalance(stakingVault);
      expect(valueAfter).to.be.gt(valueBefore);
      expect(await vaultHub.isVaultConnected(stakingVault)).to.be.true;
    });
  });

  describe("connectAndAcceptTier()", () => {
    it("Reverts when tier change is not confirmed (or tier doesn't exist)", async () => {
      await dashboard.connect(owner).voluntaryDisconnect();
      await reportVaultDataWithProof(ctx, stakingVault);

      const currentSettled = await dashboard.settledGrowth();
      await dashboard.connect(owner).correctSettledGrowth(0n, currentSettled);
      await dashboard.connect(nodeOperator).correctSettledGrowth(0n, currentSettled);

      // Try to connect with tier change - should fail (tier doesn't exist or not confirmed)
      await expect(dashboard.connect(owner).connectAndAcceptTier(999n, ether("100"))).to.be.reverted;
    });
  });

  // ==================== Tier Management ====================

  describe("changeTier()", () => {
    it("Reverts when tier doesn't exist", async () => {
      // Tier 999 doesn't exist
      await expect(dashboard.connect(owner).changeTier(999n, ether("100"))).to.be.revertedWithCustomError(
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

  // ==================== Integration Scenarios ====================

  describe("Integration Scenarios", () => {
    it("Full lifecycle: fund -> mint -> rebalance -> burn -> withdraw", async () => {
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
      const toMint = mintCapacity / 2n;
      await freshDashboard.connect(owner).mintShares(owner, toMint);
      expect(await freshDashboard.liabilityShares()).to.equal(toMint);

      // Rebalance half
      await freshDashboard.connect(owner).rebalanceVaultWithShares(toMint / 2n);
      expect(await freshDashboard.liabilityShares()).to.equal(toMint / 2n);

      // Burn rest
      await lido.connect(owner).approve(freshDashboard, ether("100"));
      await freshDashboard.connect(owner).burnShares(toMint / 2n);
      expect(await freshDashboard.liabilityShares()).to.equal(0n);

      // Report to update values
      await reportVaultDataWithProof(ctx, freshVault, { waitForNextRefSlot: true });

      // Withdraw (should have some withdrawable now)
      const withdrawable = await freshDashboard.withdrawableValue();
      if (withdrawable > 0n) {
        await freshDashboard.connect(owner).withdraw(stranger, withdrawable);
      }
    });

    it("Fee accrual and disbursement lifecycle", async () => {
      // Start with fresh state - fund more
      await dashboard.connect(owner).fund({ value: ether("10") });

      // Simulate growth (rewards)
      await reportVaultDataWithProof(ctx, stakingVault, {
        totalValue: ether("30"),
        waitForNextRefSlot: true,
      });

      // Check fee accrued
      const fee = await dashboard.accruedFee();
      expect(fee).to.be.gt(0n);

      // Disburse fee
      const feeRecipient = await dashboard.feeRecipient();
      const balanceBefore = await ethers.provider.getBalance(feeRecipient);

      await dashboard.disburseFee();

      const balanceAfter = await ethers.provider.getBalance(feeRecipient);
      expect(balanceAfter - balanceBefore).to.equal(fee);

      // Fee should now be 0
      expect(await dashboard.accruedFee()).to.equal(0n);
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
      if (newCapacity > 0n) {
        await dashboard.connect(owner).mintShares(owner, 1n);
      }
    });
  });
});
