import { expect } from "chai";
import { ContractTransactionReceipt, keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  Dashboard,
  HashConsensus__MockForVaultHub,
  LazyOracle,
  Lido__MockForVaultHub,
  LidoLocator,
  StakingVault,
  VaultFactory,
  VaultHub,
  WstETH__Harness,
} from "typechain-types";

import { getCurrentBlockTimestamp, impersonate } from "lib";
import { findEvents } from "lib/event";
import { createVaultsReportTree } from "lib/protocol";
import { ether } from "lib/units";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP, ZERO_BYTES32 } from "test/suite";

const SHARE_LIMIT = ether("10");

const NODE_OPERATOR_FEE = 1_00n;
const CONFIRM_EXPIRY = 24 * 60 * 60;
const QUARANTINE_PERIOD = 259200;
const MAX_REWARD_RATIO_BP = 350;
const MAX_SANE_LIDO_FEES_PER_SECOND = 1000000000000000000n;

describe("VaultHub.sol:forceRebalance", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let vaultFactory: VaultFactory;
  let vault: StakingVault;
  let dashboard: Dashboard;
  let lazyOracle: LazyOracle;

  let lido: Lido__MockForVaultHub;
  let wsteth: WstETH__Harness;
  let hashConsensus: HashConsensus__MockForVaultHub;

  let lazyOracleSigner: HardhatEthersSigner;
  let dashboardSigner: HardhatEthersSigner;

  let vaultAddress: string;
  let dashboardAddress: string;

  let originalState: string;

  before(async () => {
    [deployer, user, stranger] = await ethers.getSigners();

    const depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");
    lido = await ethers.deployContract("Lido__MockForVaultHub");
    wsteth = await ethers.deployContract("WstETH__Harness", [lido]);
    hashConsensus = await ethers.deployContract("HashConsensus__MockForVaultHub");

    locator = await deployLidoLocator({ lido });
    // OperatorGrid
    const operatorGridMock = await ethers.deployContract("OperatorGrid__MockForVaultHub", [], { from: deployer });
    const operatorGrid = await ethers.getContractAt("OperatorGrid", operatorGridMock, deployer);
    await operatorGridMock.initialize(ether("1"));

    // LazyOracle
    const lazyOracleImpl = await ethers.deployContract("LazyOracle", [locator]);
    const lazyOracleProxy = await ethers.deployContract("OssifiableProxy", [
      lazyOracleImpl,
      deployer,
      new Uint8Array(),
    ]);
    lazyOracle = await ethers.getContractAt("LazyOracle", lazyOracleProxy);
    await lazyOracle.initialize(deployer, QUARANTINE_PERIOD, MAX_REWARD_RATIO_BP, MAX_SANE_LIDO_FEES_PER_SECOND);

    // VaultHub
    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      lido,
      await hashConsensus.getAddress(),
      VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
    ]);

    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);
    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);
    vaultHub = vaultHubAdmin.connect(user);

    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_CODEHASH_SET_ROLE(), user);

    // VaultFactory
    const impl = await ethers.deployContract("StakingVault", [depositContract]);
    const beacon = await ethers.deployContract("UpgradeableBeacon", [impl, user]);
    const dashboardImpl = await ethers.deployContract("Dashboard", [lido, wsteth, vaultHub, locator]);
    vaultFactory = await ethers.deployContract("VaultFactory", [locator, beacon, dashboardImpl]);

    const beaconProxy = await ethers.deployContract("PinnedBeaconProxy", [beacon, "0x"]);
    const beaconProxyCode = await ethers.provider.getCode(await beaconProxy.getAddress());
    const beaconProxyCodeHash = keccak256(beaconProxyCode);
    await vaultHub.connect(user).setAllowedCodehash(beaconProxyCodeHash, true);

    // Update LidoLocator with new contacts
    await updateLidoLocatorImplementation(await locator.getAddress(), {
      vaultHub,
      operatorGrid,
      vaultFactory,
      lazyOracle,
    });

    const vaultCreationTx = (await vaultFactory
      .createVaultWithDashboard(user, user, user, NODE_OPERATOR_FEE, CONFIRM_EXPIRY, [], { value: ether("1.0") })
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const vaultCreationEvents = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = vaultCreationEvents[0];
    vault = await ethers.getContractAt("StakingVault", vaultCreatedEvent.args.vault, user);
    vaultAddress = await vault.getAddress();

    const dashboardCreationEvents = findEvents(vaultCreationTx, "DashboardCreated");
    const dashboardCreatedEvent = dashboardCreationEvents[0];
    dashboard = await ethers.getContractAt("Dashboard", dashboardCreatedEvent.args.dashboard, user);
    dashboardAddress = await dashboard.getAddress();

    dashboardSigner = await impersonate(dashboardAddress, ether("100"));
    lazyOracleSigner = await impersonate(await lazyOracle.getAddress(), ether("100"));

    await vaultHub.connect(user).updateShareLimit(vaultAddress, SHARE_LIMIT);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function refreshReport() {
    const timestamp = await getCurrentBlockTimestamp();
    const accountingOracleSigner = await impersonate(await locator.accountingOracle(), ether("100"));
    await lazyOracle.connect(accountingOracleSigner).updateReportData(timestamp, 0, ZERO_BYTES32, "");
    await vaultHub
      .connect(lazyOracleSigner)
      .applyVaultReport(vaultAddress, await getCurrentBlockTimestamp(), ether("1"), ether("1"), 0n, 0n, 0n);
  }

  it("reverts if vault is zero address", async () => {
    await expect(vaultHub.forceRebalance(ethers.ZeroAddress)).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
  });

  it("reverts if vault is not connected to the hub", async () => {
    const vaultCreationTx = (await vaultFactory
      .createVaultWithDashboardWithoutConnectingToVaultHub(user, user, user, NODE_OPERATOR_FEE, CONFIRM_EXPIRY, [])
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    await expect(vaultHub.forceRebalance(vaultCreatedEvent.args.vault))
      .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
      .withArgs(vaultCreatedEvent.args.vault);
  });

  it("reverts if called for a disconnecting vault", async () => {
    await refreshReport();
    await vaultHub.connect(user).disconnect(vaultAddress);

    await expect(vaultHub.forceRebalance(vaultAddress))
      .to.be.revertedWithCustomError(vaultHub, "VaultIsDisconnecting")
      .withArgs(vaultAddress);
  });

  it("reverts if called for a disconnecting vault", async () => {
    await refreshReport();
    await vaultHub.connect(user).disconnect(vaultAddress);

    await vaultHub
      .connect(lazyOracleSigner)
      .applyVaultReport(vaultAddress, await getCurrentBlockTimestamp(), 0n, 0n, 0n, 0n, 0n);

    await expect(vaultHub.forceRebalance(vaultAddress))
      .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
      .withArgs(vaultAddress);
  });

  context("unhealthy vault", () => {
    let timestamp: bigint;

    beforeEach(async () => {
      timestamp = await getCurrentBlockTimestamp();
      const [refSlot] = await hashConsensus.getCurrentFrame();
      const accountingOracleSigner = await impersonate(await locator.accountingOracle(), ether("100"));
      const reportTree = createVaultsReportTree([
        {
          vault: vaultAddress,
          totalValue: ether("1"),
          accruedLidoFees: ether("1"),
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
      ]);
      await lazyOracle.connect(accountingOracleSigner).updateReportData(timestamp, refSlot, reportTree.root, "");

      await vaultHub
        .connect(lazyOracleSigner)
        .applyVaultReport(vaultAddress, timestamp, ether("1"), ether("1"), 0n, 0n, 0n);

      await vaultHub.connect(dashboardSigner).fund(vaultAddress, { value: ether("1") });
      await vaultHub.connect(dashboardSigner).mintShares(vaultAddress, user, ether("0.8"));

      await vaultHub
        .connect(lazyOracleSigner)
        .applyVaultReport(vaultAddress, timestamp, ether("0.9"), ether("2"), 0n, ether("0.8"), 0n);
    });

    it("rebalances the vault with available balance", async () => {
      const sharesMintedBefore = await vaultHub.liabilityShares(vaultAddress);
      const balanceBefore = await ethers.provider.getBalance(vaultAddress);
      const expectedRebalanceAmount = await vaultHub.rebalanceShortfall(vaultAddress);
      const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount);

      const balanceAfter = await ethers.provider.getBalance(vaultAddress);
      expect(balanceAfter).to.equal(balanceBefore - expectedRebalanceAmount);

      const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
      expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);
    });

    it("rebalances with maximum available amount if shortfall exceeds balance", async () => {
      // Mint +0.1 ether of shares to the vault
      await vaultHub.connect(dashboardSigner).fund(vaultAddress, { value: ether("1") });
      await vaultHub.connect(dashboardSigner).mintShares(vaultAddress, user, ether("0.1"));

      expect(await vaultHub.liabilityShares(vaultAddress)).to.equal(ether("0.9"));

      await vaultHub
        .connect(lazyOracleSigner)
        .applyVaultReport(vaultAddress, timestamp, ether("1"), ether("3"), 0n, ether("0.9"), 0n);

      expect(await vaultHub.totalValue(vaultAddress)).to.equal(ether("1"));

      const sharesMintedBefore = await vaultHub.liabilityShares(vaultAddress);
      const shortfall = await vaultHub.rebalanceShortfall(vaultAddress);

      const expectedRebalanceAmount = shortfall / 2n;
      await setBalance(vaultAddress, expectedRebalanceAmount); // cheat to make balance lower than rebalanceShortfall

      const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount);

      const balanceAfter = await ethers.provider.getBalance(vaultAddress);
      expect(balanceAfter).to.equal(0);

      const sharesMintedAfter = await vaultHub.liabilityShares(vaultAddress);
      expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);
    });

    it("can be called by anyone", async () => {
      const balanceBefore = await ethers.provider.getBalance(vaultAddress);
      const shortfall = await vaultHub.rebalanceShortfall(vaultAddress);

      const expectedRebalanceAmount = shortfall < balanceBefore ? shortfall : balanceBefore;
      const expectedSharesToBeBurned = await lido.getSharesByPooledEth(expectedRebalanceAmount);

      await expect(vaultHub.connect(stranger).forceRebalance(vaultAddress))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, expectedSharesToBeBurned, expectedRebalanceAmount);
    });
  });

  context("healthy vault", () => {
    it("reverts if vault is healthy", async () => {
      const balanceBefore = await ethers.provider.getBalance(vaultAddress);

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.be.revertedWithCustomError(vaultHub, "AlreadyHealthy")
        .withArgs(vaultAddress);

      const balanceAfter = await ethers.provider.getBalance(vaultAddress);
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });
});
