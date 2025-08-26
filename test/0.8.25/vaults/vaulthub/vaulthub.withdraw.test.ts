import { expect } from "chai";
import { ethers } from "hardhat";
import { describe } from "mocha";

import { GWEI_TO_WEI } from "@nomicfoundation/ethereumjs-util";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { Lido, StakingVault__MockForVaultHub, VaultHub } from "typechain-types";

import { advanceChainTime, ether } from "lib";

import { deployVaults } from "test/deploy";
import { Snapshot } from "test/suite";

const CONNECTION_DEPOSIT = ether("1");

describe("VaultHub.sol:withdrawal", () => {
  let vaultsContext: Awaited<ReturnType<typeof deployVaults>>;
  let vaultHub: VaultHub;
  let lido: Lido;

  let disconnectedVault: StakingVault__MockForVaultHub;
  let connectedVault: StakingVault__MockForVaultHub;

  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let originalState: string;

  before(async () => {
    [deployer, user, redemptionMaster, stranger] = await ethers.getSigners();

    vaultsContext = await deployVaults({ deployer, admin: user });
    vaultHub = vaultsContext.vaultHub;
    lido = vaultsContext.lido;

    disconnectedVault = await vaultsContext.createMockStakignVault(user, user);
    connectedVault = await vaultsContext.createMockStakignVaultAndConnect(user, user);

    await vaultHub.connect(deployer).grantRole(await vaultHub.REDEMPTION_MASTER_ROLE(), redemptionMaster);
    await vaultHub.connect(deployer).grantRole(await vaultHub.PAUSE_ROLE(), user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("withdrawableValue", () => {
    it("returns 0 if the vault is not connected", async () => {
      const value = await vaultHub.withdrawableValue(disconnectedVault);
      expect(value).to.equal(0);
    });

    it("returns 0 when totalValue is equal to locked", async () => {
      await connectedVault.connect(user).fund({ value: ether("9") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("10") });
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("10"));

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("9")); // 10% RR

      const locked = await vaultHub.locked(connectedVault);
      expect(locked).to.equal(ether("10"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(0n);
    });

    it("returns 0 when vault balance is 0", async () => {
      await connectedVault.connect(user).fund({ value: ether("100") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("100") });

      await setBalance(await connectedVault.getAddress(), 0);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(0n);
    });

    it("returns 0 when vault has zero total value", async () => {
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: 0n });
      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(0n);
    });

    it("returns 0 when obligations cap vault balance", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: ether("9") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      const shares = ether("9");
      await vaultHub.connect(user).mintShares(connectedVault, user, shares); // RR 10%, locked = 10 ether
      expect(await vaultHub.locked(connectedVault)).to.equal(totalValue);

      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n); // all for redemption
      expect((await vaultHub.vaultRecord(connectedVault)).redemptionShares).to.equal(shares);

      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);

      const record = await vaultHub.vaultRecord(connectedVault);
      const obligations = record.redemptionShares + record.cumulativeLidoFees;
      expect(obligations).to.equal(shares);

      const withdrawableOnRedemptionBalance = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawableOnRedemptionBalance).to.equal(0n);
    });

    it("returns correct withdrawable value when all conditions are met", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("1"));

      const record = await vaultHub.vaultRecord(connectedVault);
      const locked = record.locked;
      const expected = totalValue - locked;

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(expected);
    });

    it("accounts for unsettled Lido fees in obligations", async () => {
      const totalValue = ether("10");
      const cumulativeLidoFees = ether("1");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      const withdrawableBefore = await vaultHub.withdrawableValue(connectedVault);

      // 10 balance, 1 locked, 1 unsettled fees, 8 withdrawable
      expect(withdrawableBefore).to.equal(ether("8"));
    });

    it("accounts for redemption shares in obligations part on CL", async () => {
      const totalValue = ether("9");
      const redemptionShares = ether("3");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, redemptionShares);
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n); // all for redemption

      const balance = ether("5");
      await setBalance(await connectedVault.getAddress(), balance);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("9"));
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);

      // 5 balance, 3 forced for redemption, 2 withdrawable
      expect(withdrawable).to.equal(ether("2"));
    });

    it("accounts for redemption shares in obligations all on EL", async () => {
      const totalValue = ether("9");
      const redemptionShares = ether("3");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, redemptionShares);
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n); // all for redemption

      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("9"));
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);

      // 9 balance, 4 locked, 5 withdrawable
      expect(withdrawable).to.equal(ether("5"));
    });
  });

  context("withdraw", () => {
    it("reverts when vault is not connected", async () => {
      await expect(vaultHub.connect(user).withdraw(disconnectedVault, user, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("reverts when caller is not vault owner", async () => {
      await expect(
        vaultHub.connect(stranger).withdraw(connectedVault, stranger, ether("1")),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts when vault report is stale", async () => {
      // Fund vault and report
      await connectedVault.connect(user).fund({ value: ether("10") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("10") });

      await advanceChainTime(3n * 24n * 60n * 60n);

      await expect(vaultHub.connect(user).withdraw(connectedVault, user, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );
    });

    it("reverts when withdrawal amount exceeds withdrawable value with gifting", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      // gift to the vault
      await setBalance(await connectedVault.getAddress(), totalValue * 10n);
      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(totalValue - CONNECTION_DEPOSIT);

      const excessiveAmount = totalValue + ether("1");
      await expect(vaultHub.connect(user).withdraw(connectedVault, user, excessiveAmount))
        .to.be.revertedWithCustomError(vaultHub, "AmountExceedsWithdrawableValue")
        .withArgs(withdrawable, excessiveAmount);
    });

    it("reverts when withdrawal amount exceeds withdrawable value with minting", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      // Mint shares to create locked amount
      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      const excessiveAmount = withdrawable + ether("1");

      await expect(vaultHub.connect(user).withdraw(connectedVault, user, excessiveAmount))
        .to.be.revertedWithCustomError(vaultHub, "AmountExceedsWithdrawableValue")
        .withArgs(withdrawable, excessiveAmount);
    });

    it("reverts when vault is pending disconnect", async () => {
      await connectedVault.connect(user).fund({ value: ether("10") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: ether("10") });

      // Initiate disconnect
      await vaultHub.connect(user).disconnect(connectedVault);

      await expect(vaultHub.connect(user).withdraw(connectedVault, user, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "VaultIsDisconnecting",
      );
    });

    it("reverts withdrawal when vaulthub is paused", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).pauseFor(1000n);
      await expect(vaultHub.connect(user).withdraw(connectedVault, user, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("successfully withdraws when amount equals withdrawable value", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
    });

    it("successfully withdraws partial amount", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      const partialAmount = withdrawable / 2n;

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, partialAmount);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(partialAmount);
    });

    it("updates inOutDelta correctly after withdrawal", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      const withdrawalAmount = withdrawable / 2n;

      const inOutDeltaBefore = await vaultHub.vaultRecord(connectedVault);
      await vaultHub.connect(user).withdraw(connectedVault, user, withdrawalAmount);
      const inOutDeltaAfter = await vaultHub.vaultRecord(connectedVault);

      // inOutDelta should decrease by the withdrawal amount
      expect(inOutDeltaAfter.inOutDelta[1].value).to.equal(inOutDeltaBefore.inOutDelta[0].value - withdrawalAmount);
    });

    it("handles withdrawal with minimal vault balance", async () => {
      const minimalBalance = CONNECTION_DEPOSIT + 1n;
      await connectedVault.connect(user).fund({ value: minimalBalance });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: minimalBalance });

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(1n);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal when vault has locked amount", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));
      const locked = await vaultHub.locked(connectedVault);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(totalValue - locked);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal when vault has unsettled Lido fees", async () => {
      const totalValue = ether("10");
      const cumulativeLidoFees = ether("2");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));
      const locked = await vaultHub.locked(connectedVault);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(totalValue - locked - cumulativeLidoFees);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal with complex fee and redemptions scenario", async () => {
      const totalValue = ether("10");
      const cumulativeLidoFees = ether("1");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      const shares = ether("5");
      const targetShares = ether("3");
      const redemptionValue = await lido.getPooledEthByShares(shares - targetShares);
      await vaultHub.connect(user).mintShares(connectedVault, user, shares);
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, targetShares);

      const elBalance = totalValue - ether("5");
      await setBalance(await connectedVault.getAddress(), elBalance); // 5 ether for CL balance

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(elBalance - redemptionValue - cumulativeLidoFees);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal after vault is resumed", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      const pauseFor = 1000n;

      await vaultHub.connect(user).pauseFor(pauseFor);
      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, ether("1"))).to.be.reverted;

      await advanceChainTime(pauseFor);
      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, ether("1"))).to.not.be.reverted;
    });

    it("handles withdrawal with minimal locked amount", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, 1n);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(totalValue - CONNECTION_DEPOSIT - 1n);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal with maximum locked amount", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      const maxShares = ether("9") - 1n;
      await vaultHub.connect(user).mintShares(connectedVault, user, maxShares);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(1n);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal with multiple small amounts (rounding)", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      const smallAmount = withdrawable / 10n;

      for (let i = 0; i < 10; i++) {
        await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, smallAmount)).to.not.be.reverted;
      }

      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal with exact precision amounts", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      const precisionAmount = withdrawable - (withdrawable % GWEI_TO_WEI);
      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, precisionAmount)).to.not.be.reverted;
    });
  });

  context("withdrawal state transitions", () => {
    it("maintains correct state after multiple withdrawals", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });
      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      for (let i = 0; i < 3; i++) {
        const withdrawable = await vaultHub.withdrawableValue(connectedVault);
        const withdrawalAmount = withdrawable / 3n;

        await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawalAmount);
        const newWithdrawable = await vaultHub.withdrawableValue(connectedVault);
        expect(newWithdrawable).to.be.lt(withdrawable);
      }
    });

    it("handles withdrawal after vault rebalancing", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      const shares = ether("5");
      const targetShares = ether("4");
      await vaultHub.connect(user).mintShares(connectedVault, user, shares);

      const redemptionShares = shares - targetShares;
      expect(redemptionShares).to.equal(ether("1"));
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, targetShares);

      const recordBefore = await vaultHub.vaultRecord(connectedVault);
      expect(recordBefore.redemptionShares).to.equal(redemptionShares);

      const rebalanceValue = await lido.getPooledEthByShares(redemptionShares);
      await vaultHub.connect(user).rebalance(connectedVault, rebalanceValue);

      const recordAfter = await vaultHub.vaultRecord(connectedVault);
      expect(recordAfter.redemptionShares).to.equal(0n);

      const newWithdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(newWithdrawable).to.equal(totalValue - recordAfter.locked - rebalanceValue);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, newWithdrawable)).to.not.be.reverted;
    });

    it("handles withdrawal after fee settlement", async () => {
      const totalValue = ether("10");
      const cumulativeLidoFees = ether("2");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      await vaultHub.settleLidoFees(connectedVault);

      const newWithdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(newWithdrawable).to.equal(totalValue - cumulativeLidoFees - CONNECTION_DEPOSIT);

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, newWithdrawable)).to.not.be.reverted;
    });
  });
});
