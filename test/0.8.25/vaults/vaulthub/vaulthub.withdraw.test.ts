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
      const shares = ether("1");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, shares);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("2")); // 1 shares + 1 minimal reserve = 2
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("8")); // 10 - 2
    });

    it("accounts for unsettled Lido fees in obligations", async () => {
      const totalValue = ether("10");
      const cumulativeLidoFees = ether("1");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      const record = await vaultHub.vaultRecord(connectedVault);
      expect(record.cumulativeLidoFees).to.equal(cumulativeLidoFees);
      expect(record.settledLidoFees).to.equal(0n);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("1")); // minimal reserve

      // 10 - 1 - 1
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("8"));
    });

    it("accounts for redemption shares (part of the total value is on CL)", async () => {
      const totalValue = ether("9");
      const redemptionShares = ether("3");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, redemptionShares);
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4")); // 3 shares + 1 minimal reserve = 4

      // 9 - 4
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("5"));

      const balance = ether("5");
      await setBalance(await connectedVault.getAddress(), balance);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4"));

      // 5 - 3 (minimal reserve is locked on CL)
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("2"));
    });

    it("accounts for redemption shares and unsettled fees (part of the total value is on CL)", async () => {
      const totalValue = ether("9");
      const redemptionShares = ether("3");
      const cumulativeLidoFees = ether("1");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      await vaultHub.connect(user).mintShares(connectedVault, user, redemptionShares);
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, 0n);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4")); // 3 shares + 1 minimal reserve = 4

      // 9 - 4 - 1
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("4"));

      const balance = ether("5");
      await setBalance(await connectedVault.getAddress(), balance);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4"));

      // 5 - 3 (minimal reserve is locked on CL) - 1
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("1"));
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

    it("reverts when vaulthub is paused", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).pauseFor(1000n);
      await expect(vaultHub.connect(user).withdraw(connectedVault, user, ether("1"))).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts when withdrawal amount exceeds withdrawable value (gifting)", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      // gift to the vault
      await setBalance(await connectedVault.getAddress(), totalValue * 10n);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(CONNECTION_DEPOSIT);

      // 10 - 1
      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(totalValue - CONNECTION_DEPOSIT);

      const excessiveAmount = totalValue + ether("1");
      await expect(vaultHub.connect(user).withdraw(connectedVault, user, excessiveAmount))
        .to.be.revertedWithCustomError(vaultHub, "AmountExceedsWithdrawableValue")
        .withArgs(connectedVault, withdrawable, excessiveAmount);
    });

    it("reverts when withdrawal amount exceeds withdrawable value (minting)", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      // Mint shares to create locked amount
      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("4")); // 10 - 6

      const excessiveAmount = withdrawable + 1n;
      await expect(vaultHub.connect(user).withdraw(connectedVault, user, excessiveAmount))
        .to.be.revertedWithCustomError(vaultHub, "AmountExceedsWithdrawableValue")
        .withArgs(connectedVault, withdrawable, excessiveAmount);
    });

    it("withdraws full amount when amount equals withdrawable value", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("4")); // 10 - 6

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("6")); // 10 - 4
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("withdraws partial amounts", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("4")); // 10 - 6

      const partialAmount = withdrawable / 2n;

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, partialAmount);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(partialAmount);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("8")); // 10 - 2
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("2")); // 4 - 2
    });

    it("updates inOutDelta correctly after withdrawal", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("4")); // 10 - 6

      const withdrawalAmount = withdrawable / 2n;
      const inOutDeltaBefore = await vaultHub.vaultRecord(connectedVault);
      await vaultHub.connect(user).withdraw(connectedVault, user, withdrawalAmount);
      const inOutDeltaAfter = await vaultHub.vaultRecord(connectedVault);

      // inOutDelta should decrease by the withdrawal amount
      expect(inOutDeltaAfter.inOutDelta[1].value).to.equal(inOutDeltaBefore.inOutDelta[0].value - withdrawalAmount);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("8")); // 10 - 2
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(ether("2")); // 4 - 2
    });

    it("handles withdrawal with minimal vault balance", async () => {
      const minimalBalance = CONNECTION_DEPOSIT + 1n;
      await connectedVault.connect(user).fund({ value: minimalBalance });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: minimalBalance });

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(1n);

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(CONNECTION_DEPOSIT);
      expect(await vaultHub.locked(connectedVault)).to.equal(CONNECTION_DEPOSIT);
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    // TODO: fix this test with proper caps
    it.skip("handles withdrawal with maximum (uint104) vault balance", async () => {
      const maxUint104 = 2n ** 104n - 1n;

      await setBalance(await connectedVault.getAddress(), maxUint104);
      await vaultsContext.reportVault({ vault: connectedVault, totalValue: maxUint104 });

      expect(await vaultHub.totalValue(connectedVault)).to.equal(maxUint104);
      expect(await vaultHub.locked(connectedVault)).to.equal(CONNECTION_DEPOSIT);

      console.log("maxUint104", maxUint104);
      console.log("CONNECTION_DEPOSIT", CONNECTION_DEPOSIT);
      console.log("maxUint104 - CONNECTION_DEPOSIT", maxUint104 - CONNECTION_DEPOSIT);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(maxUint104 - CONNECTION_DEPOSIT);

      console.log("withdrawable", withdrawable);

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(CONNECTION_DEPOSIT);
      expect(await vaultHub.locked(connectedVault)).to.equal(CONNECTION_DEPOSIT);
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal when vault has unsettled Lido fees", async () => {
      const totalValue = ether("10");
      const cumulativeLidoFees = ether("2");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("1"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("7")); // 10 - 1 - 2

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("3")); // 10 - 7
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("1"));
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal with complex fee and redemptions scenario", async () => {
      const totalValue = ether("10");
      const clBalance = ether("5");
      const cumulativeLidoFees = ether("1");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, cumulativeLidoFees });

      const shares = ether("5");
      const targetShares = ether("3");
      const redemptionShares = shares - targetShares;
      expect(redemptionShares).to.equal(ether("2"));

      await vaultHub.connect(user).mintShares(connectedVault, user, shares);
      await vaultHub.connect(redemptionMaster).setLiabilitySharesTarget(connectedVault, targetShares);

      const elBalance = totalValue - clBalance;
      await setBalance(await connectedVault.getAddress(), elBalance);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("2")); // 5 - 2 (minimal reserve is locked on CL)

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("8")); // 10 - 2
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("6")); // 5 shares + 1 minimal reserve = 6
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal with minimal locked amount", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, 1n);

      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);
      expect(await vaultHub.locked(connectedVault)).to.equal(CONNECTION_DEPOSIT + 1n);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(ether("9") - 1n); // 10 - 1 - 1wei

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(CONNECTION_DEPOSIT + 1n);
      expect(await vaultHub.locked(connectedVault)).to.equal(CONNECTION_DEPOSIT + 1n);
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal with just under the fully locked amount", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      const maxShares = ether("9") - 1n;
      await vaultHub.connect(user).mintShares(connectedVault, user, maxShares);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      expect(withdrawable).to.equal(1n);

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, withdrawable);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(withdrawable);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue - 1n);
      expect(await vaultHub.locked(connectedVault)).to.equal(totalValue - 1n);
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal with multiple small amounts (rounding)", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      const smallAmount = withdrawable / 10n;

      for (let i = 0; i < 10; i++) {
        const balanceBefore = await ethers.provider.getBalance(stranger);
        await vaultHub.connect(user).withdraw(connectedVault, stranger, smallAmount);
        const balanceAfter = await ethers.provider.getBalance(stranger);

        expect(balanceAfter - balanceBefore).to.equal(smallAmount);
      }

      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
    });

    it("handles withdrawal with exact precision amounts", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("5") + 1n);

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);
      // round down to the nearest GWEI
      const precisionAmount = withdrawable - (withdrawable % GWEI_TO_WEI);
      const mod = withdrawable % GWEI_TO_WEI;

      const balanceBefore = await ethers.provider.getBalance(stranger);
      await vaultHub.connect(user).withdraw(connectedVault, stranger, precisionAmount);
      const balanceAfter = await ethers.provider.getBalance(stranger);

      expect(balanceAfter - balanceBefore).to.equal(precisionAmount);
      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(mod);
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

      const newWithdrawableBeforeReport = await vaultHub.withdrawableValue(connectedVault);
      expect(newWithdrawableBeforeReport).to.equal(ether("3")); // 9 - 6 locked = 3

      await vaultsContext.reportVault({ vault: connectedVault }); // unlock 1 ether

      const newWithdrawableAfterReport = await vaultHub.withdrawableValue(connectedVault);
      expect(newWithdrawableAfterReport).to.equal(ether("4")); // 9 - 5 locked = 4

      await expect(vaultHub.connect(user).withdraw(connectedVault, stranger, newWithdrawableAfterReport)).to.not.be
        .reverted;
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
