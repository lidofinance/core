import { expect } from "chai";
import { ethers } from "hardhat";
import { describe } from "mocha";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import { StakingVault__MockForVaultHub, VaultHub } from "typechain-types";

import { ether } from "lib";

import { deployVaults } from "test/deploy";
import { Snapshot } from "test/suite";

describe("VaultHub.sol:withdrawal", () => {
  let vaultsContext: Awaited<ReturnType<typeof deployVaults>>;
  let vaultHub: VaultHub;

  let disconnectedVault: StakingVault__MockForVaultHub;
  let connectedVault: StakingVault__MockForVaultHub;

  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let redemptionMaster: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [deployer, user, redemptionMaster] = await ethers.getSigners();

    vaultsContext = await deployVaults({ deployer, admin: user });
    vaultHub = vaultsContext.vaultHub;

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
      const initialTotalValue = await vaultHub.totalValue(connectedVault);
      const initialFunding = ether("9");

      const totalValue = initialTotalValue + initialFunding;
      await connectedVault.connect(user).fund({ value: initialFunding });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });
      expect(await vaultHub.totalValue(connectedVault)).to.equal(totalValue);

      await vaultHub.connect(user).mintShares(connectedVault, user, ether("9")); // 10% RR

      const locked = await vaultHub.locked(connectedVault);
      expect(locked).to.equal(totalValue);

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

    it("returns 0 when obligations exceed available balance", async () => {
      const totalValue = ether("10");
      await connectedVault.connect(user).fund({ value: ether("9") });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      const redemptionShares = ether("9");
      await vaultHub.connect(user).mintShares(connectedVault, user, redemptionShares); // RR 10%, locked = 10 ether
      expect(await vaultHub.locked(connectedVault)).to.equal(totalValue);

      await vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, redemptionShares);

      expect(await vaultHub.withdrawableValue(connectedVault)).to.equal(0n);
      expect(await vaultHub.obligationsValue(connectedVault)).to.equal(redemptionShares);

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
      const accruedLidoFees = ether("1");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue, accruedLidoFees });

      const withdrawableBefore = await vaultHub.withdrawableValue(connectedVault);

      // 10 balance, 1 locked, 1 unsettled fees, 8 withdrawable
      expect(withdrawableBefore).to.equal(ether("8"));
    });

    it("accounts for redemption shares in obligations", async () => {
      const totalValue = ether("9");
      const redemptionShares = ether("3");

      await connectedVault.connect(user).fund({ value: totalValue });
      await vaultsContext.reportVault({ vault: connectedVault, totalValue });

      await vaultHub.connect(user).mintShares(connectedVault, user, redemptionShares);
      await vaultHub.connect(redemptionMaster).updateRedemptionShares(connectedVault, redemptionShares);

      const balance = ether("5");
      await setBalance(await connectedVault.getAddress(), balance);
      expect(await vaultHub.totalValue(connectedVault)).to.equal(ether("9"));
      expect(await vaultHub.locked(connectedVault)).to.equal(ether("4"));

      const withdrawable = await vaultHub.withdrawableValue(connectedVault);

      // 5 balance, 3 forced for redemption, 2 withdrawable
      expect(withdrawable).to.equal(ether("2"));
    });
  });

  context("withdraw", () => {});
});
