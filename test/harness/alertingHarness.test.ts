import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  AlertingHarness,
  LazyOracle__MockForVaultHub,
  Lido,
  LidoLocator,
  StakingVault__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { ether } from "lib";

import { deployVaults } from "test/deploy/vaults";
import { Snapshot } from "test/suite";

describe("AlertingHarness.sol", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let operator: HardhatEthersSigner;

  let lido: Lido;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let lazyOracle: LazyOracle__MockForVaultHub;
  let alertingHarness: AlertingHarness;

  let createMockStakingVaultAndConnect: (
    owner: HardhatEthersSigner,
    operator: HardhatEthersSigner,
  ) => Promise<StakingVault__MockForVaultHub>;

  let reportVaultHelper: (report: {
    vault: StakingVault__MockForVaultHub;
    reportTimestamp?: bigint;
    totalValue?: bigint;
    inOutDelta?: bigint;
    liabilityShares?: bigint;
    maxLiabilityShares?: bigint;
    cumulativeLidoFees?: bigint;
    slashingReserve?: bigint;
  }) => Promise<void>;

  let originalState: string;

  before(async () => {
    [deployer, user, operator] = await ethers.getSigners();

    const vaultsSetup = await deployVaults({ deployer, admin: user });
    lido = vaultsSetup.lido;
    vaultHub = vaultsSetup.vaultHub;
    lazyOracle = vaultsSetup.lazyOracle;
    createMockStakingVaultAndConnect = vaultsSetup.createMockStakingVaultAndConnect;
    reportVaultHelper = vaultsSetup.reportVault;

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

    alertingHarness = await ethers.deployContract("AlertingHarness", [await locator.getAddress()]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  describe("constructor", () => {
    it("reverts if locator is zero address", async () => {
      await expect(ethers.deployContract("AlertingHarness", [ZeroAddress])).to.be.revertedWithCustomError(
        alertingHarness,
        "ZeroAddress",
      );
    });

    it("sets LIDO_LOCATOR correctly", async () => {
      expect(await alertingHarness.LIDO_LOCATOR()).to.equal(await locator.getAddress());
    });
  });

  describe("version", () => {
    it("returns correct version", async () => {
      expect(await alertingHarness.VERSION()).to.equal("1.0.0");
    });
  });

  describe("getVaultData", () => {
    it("returns correct vault data for a connected vault", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      await reportVaultHelper({ vault, totalValue: ether("100") });

      const vaultData = await alertingHarness.getVaultData(await vault.getAddress());

      expect(vaultData.vault).to.equal(await vault.getAddress());
      expect(vaultData.vaultConnection.vaultIndex).to.be.greaterThan(0);
      expect(vaultData.vaultRecord.report.totalValue).to.equal(ether("100"));
      expect(vaultData.vaultRecord.report.inOutDelta).to.equal(ether("1")); // connected vault has 1 ETH deposit
      expect(vaultData.vaultPendingActivationsCount).to.equal(0n);
      expect(vaultData.stakingVaultData.stakingVaultNodeOperator).to.equal(await operator.getAddress());
      expect(vaultData.stakingVaultData.stakingVaultDepositor).to.equal(await locator.predepositGuarantee());
      expect(vaultData.stakingVaultData.stakingVaultOwner).to.equal(await locator.vaultHub());
      expect(vaultData.stakingVaultData.stakingVaultPendingOwner).to.equal(ZeroAddress);
      expect(vaultData.stakingVaultData.stakingVaultStagedBalance).to.equal(0n);
      expect(vaultData.stakingVaultData.stakingVaultAvailableBalance).to.equal(ether("1"));
      expect(vaultData.stakingVaultData.stakingVaultBeaconChainDepositsPaused).to.equal(false);
    });
  });

  describe("batchVaultData", () => {
    it("returns empty array when no vaults exist", async () => {
      const batch = await alertingHarness.batchVaultData(0, 10);
      expect(batch).to.have.length(0);
    });

    it("returns correct data for single vault", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      await reportVaultHelper({ vault, totalValue: ether("100") });
      expect(await vaultHub.vaultsCount()).to.equal(1);

      const batch = await alertingHarness.batchVaultData(0, 10);

      expect(batch).to.have.length(1);
      expect(batch[0].vault).to.equal(await vault.getAddress());
    });

    it("returns correct data for multiple vaults", async () => {
      const vault1 = await createMockStakingVaultAndConnect(user, operator);
      const vault2 = await createMockStakingVaultAndConnect(user, operator);
      const vault3 = await createMockStakingVaultAndConnect(user, operator);

      await reportVaultHelper({ vault: vault1, totalValue: ether("100") });
      await reportVaultHelper({ vault: vault2, totalValue: ether("200") });
      await reportVaultHelper({ vault: vault3, totalValue: ether("300") });
      expect(await vaultHub.vaultsCount()).to.equal(3);

      const batch = await alertingHarness.batchVaultData(0, 10);
      expect(batch).to.have.length(3);
      expect(batch[0].vault).to.equal(await vault1.getAddress());
      expect(batch[1].vault).to.equal(await vault2.getAddress());
      expect(batch[2].vault).to.equal(await vault3.getAddress());
    });

    it("respects limit parameter", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchVaultData(1, 2);
      expect(batch).to.have.length(2);
    });

    it("respects offset parameter", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      const vault = await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchVaultData(1, 10);
      expect(batch).to.have.length(2);
      expect(batch[0].vault).to.equal(await vault.getAddress());
    });

    it("returns empty array when offset exceeds vault count", async () => {
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchVaultData(100, 10);
      expect(batch).to.have.length(0);
    });

    it("returns partial batch when offset + limit exceeds vault count", async () => {
      await createMockStakingVaultAndConnect(user, operator);
      await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchVaultData(1, 10);
      expect(batch).to.have.length(1);
    });
  });

  describe("batchVaultConnections", () => {
    it("returns empty array when no vaults exist", async () => {
      const batch = await alertingHarness.batchVaultConnections(1, 10);
      expect(batch).to.have.length(0);
    });

    it("returns correct connection data for vaults", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchVaultConnections(0, 10);
      expect(batch).to.have.length(1);
      expect(batch[0].vault).to.equal(await vault.getAddress());
      expect(batch[0].vaultConnection.vaultIndex).to.be.greaterThan(0);
    });
  });

  describe("batchVaultRecords", () => {
    it("returns empty array when no vaults exist", async () => {
      const batch = await alertingHarness.batchVaultRecords(0, 10);
      expect(batch).to.have.length(0);
    });

    it("returns correct record data for vaults", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      await reportVaultHelper({ vault, totalValue: ether("100") });

      const batch = await alertingHarness.batchVaultRecords(0, 10);
      expect(batch).to.have.length(1);
      expect(batch[0].vault).to.equal(await vault.getAddress());
      expect(batch[0].vaultRecord.report.totalValue).to.equal(ether("100"));
      expect(batch[0].vaultRecord.report.inOutDelta).to.equal(ether("1")); // connected vault has 1 ETH deposit
    });
  });

  describe("batchVaultQuarantines", () => {
    it("returns empty array when no vaults exist", async () => {
      const batch = await alertingHarness.batchVaultQuarantines(0, 10);
      expect(batch).to.have.length(0);
    });

    it("returns quarantine info for vaults", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      await lazyOracle.mock__setIsVaultQuarantined(await vault.getAddress(), true);

      const batch = await alertingHarness.batchVaultQuarantines(0, 10);
      expect(batch).to.have.length(1);
      expect(batch[0].vault).to.equal(await vault.getAddress());
      expect(batch[0].vaultQuarantineInfo.isActive).to.equal(true);
      expect(batch[0].vaultQuarantineInfo.pendingTotalValueIncrease).to.equal(0n);
      expect(batch[0].vaultQuarantineInfo.startTimestamp).to.equal(0n);
      expect(batch[0].vaultQuarantineInfo.endTimestamp).to.equal(0n);
      expect(batch[0].vaultQuarantineInfo.totalValueRemainder).to.equal(0n);
    });
  });

  describe("batchPendingActivations", () => {
    it("returns empty array when no vaults exist", async () => {
      const batch = await alertingHarness.batchPendingActivations(0, 10);
      expect(batch).to.have.length(0);
    });

    it("returns pending activations count for vaults", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchPendingActivations(0, 10);
      expect(batch).to.have.length(1);
      expect(batch[0].vault).to.equal(await vault.getAddress());
      expect(batch[0].vaultPendingActivationsCount).to.equal(0n);
    });
  });

  describe("batchStakingVaultData", () => {
    it("returns empty array when no vaults exist", async () => {
      const batch = await alertingHarness.batchStakingVaultData(0, 10);
      expect(batch).to.have.length(0);
    });

    it("returns staking vault data for vaults", async () => {
      const vault = await createMockStakingVaultAndConnect(user, operator);

      const batch = await alertingHarness.batchStakingVaultData(0, 10);

      expect(batch).to.have.length(1);
      expect(batch[0].vault).to.equal(await vault.getAddress());
      expect(batch[0].stakingVaultData.stakingVaultNodeOperator).to.equal(await operator.getAddress());
      expect(batch[0].stakingVaultData.stakingVaultDepositor).to.equal(await locator.predepositGuarantee());
      expect(batch[0].stakingVaultData.stakingVaultOwner).to.equal(await locator.vaultHub());
      expect(batch[0].stakingVaultData.stakingVaultPendingOwner).to.equal(ZeroAddress);
      expect(batch[0].stakingVaultData.stakingVaultStagedBalance).to.equal(0n);
      expect(batch[0].stakingVaultData.stakingVaultAvailableBalance).to.equal(ether("1"));
      expect(batch[0].stakingVaultData.stakingVaultBeaconChainDepositsPaused).to.equal(false);
    });
  });
});
