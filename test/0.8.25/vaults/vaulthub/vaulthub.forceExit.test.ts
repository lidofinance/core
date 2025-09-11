import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  LazyOracle__MockForVaultHub,
  LidoLocator,
  OperatorGrid,
  OperatorGrid__MockForVaultHub,
  OssifiableProxy,
  PredepositGuarantee__HarnessForFactory,
  StakingVault__MockForVaultHub,
  StETH__HarnessForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { GENESIS_FORK_VERSION } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";
import { findEvents } from "lib/event";
import { ether } from "lib/units";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const FORCED_REBALANCE_THRESHOLD_BP = 8_00n;
const INFRA_FEE_BP = 5_00n;
const LIQUIDITY_FEE_BP = 4_00n;
const RESERVATION_FEE_BP = 1_00n;

const FEE = 2n;

describe("VaultHub.sol:forceExit", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  let vaultHub: VaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let vault: StakingVault__MockForVaultHub;
  let steth: StETH__HarnessForVaultHub;
  let predepositGuarantee: PredepositGuarantee__HarnessForFactory;
  let locator: LidoLocator;
  let operatorGrid: OperatorGrid;
  let operatorGridMock: OperatorGrid__MockForVaultHub;
  let proxy: OssifiableProxy;
  let lazyOracle: LazyOracle__MockForVaultHub;

  let vaultAddress: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(user, user, predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    return ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
  }

  before(async () => {
    [deployer, user, feeRecipient] = await ethers.getSigners();
    const depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("10000.0") });
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee__HarnessForFactory", [
      GENESIS_FORK_VERSION,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);
    lazyOracle = await ethers.deployContract("LazyOracle__MockForVaultHub");
    locator = await deployLidoLocator({
      lido: steth,
      predepositGuarantee: predepositGuarantee,
      lazyOracle,
    });

    // OperatorGrid
    operatorGridMock = await ethers.deployContract("OperatorGrid__MockForVaultHub", [], { from: deployer });
    operatorGrid = await ethers.getContractAt("OperatorGrid", operatorGridMock, deployer);
    await operatorGridMock.initialize(ether("1"));

    // HashConsensus
    const hashConsensus = await ethers.deployContract("HashConsensus__MockForVaultHub");

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      steth,
      hashConsensus,
      VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);

    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VALIDATOR_EXIT_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract]);
    const beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [beacon]);
    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultFactory });

    vault = await createVault(vaultFactory);
    vaultAddress = await vault.getAddress();

    const connectDeposit = ether("1.0");
    await vault.connect(user).fund({ value: connectDeposit });

    await operatorGridMock.changeVaultTierParams(vault, {
      shareLimit: SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO_BP,
      forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
      infraFeeBP: INFRA_FEE_BP,
      liquidityFeeBP: LIQUIDITY_FEE_BP,
      reservationFeeBP: RESERVATION_FEE_BP,
    });

    await vault.fund({ value: ether("1") });
    await vault.transferOwnership(vaultHub);
    await vaultHub.connect(user).connectVault(vaultAddress);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function reportVault({
    targetVault,
    totalValue,
    inOutDelta,
    cumulativeLidoFees,
    liabilityShares,
    maxLiabilityShares,
    slashingReserve,
  }: {
    targetVault?: StakingVault__MockForVaultHub;
    reportTimestamp?: bigint;
    totalValue?: bigint;
    inOutDelta?: bigint;
    liabilityShares?: bigint;
    cumulativeLidoFees?: bigint;
    maxLiabilityShares?: bigint;
    slashingReserve?: bigint;
  }) {
    targetVault = targetVault ?? vault;
    await lazyOracle.refreshReportTimestamp();
    const timestamp = await lazyOracle.latestReportTimestamp();
    const record = await vaultHub.vaultRecord(targetVault);
    const activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;

    totalValue = totalValue ?? (await vaultHub.totalValue(targetVault));
    inOutDelta = inOutDelta ?? record.inOutDelta[activeIndex].value;
    liabilityShares = liabilityShares ?? record.liabilityShares;
    cumulativeLidoFees = cumulativeLidoFees ?? record.cumulativeLidoFees;
    maxLiabilityShares = maxLiabilityShares ?? record.maxLiabilityShares;
    slashingReserve = slashingReserve ?? 0n;

    await lazyOracle.mock__report(
      vaultHub,
      targetVault,
      timestamp,
      totalValue,
      inOutDelta,
      cumulativeLidoFees,
      liabilityShares,
      maxLiabilityShares,
      slashingReserve,
    );
  }

  // Simulate getting in the unhealthy state
  const makeVaultUnhealthy = async () => {
    await vault.fund({ value: ether("1") });
    await reportVault({});
    await vaultHub.mintShares(vaultAddress, user, ether("0.9"));
    await reportVault({ totalValue: ether("0.9") });
    await setBalance(vaultAddress, ether("0.85"));
  };

  context("forceValidatorExit", () => {
    it("reverts if the vault is zero address", async () => {
      await expect(
        vaultHub.forceValidatorExit(ZeroAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("reverts if vault is not connected to the hub", async () => {
      const vault_ = await createVault(vaultFactory);

      await expect(vaultHub.forceValidatorExit(vault_, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vault_);
    });

    it("reverts if called for a disconnected vault", async () => {
      await reportVault({ totalValue: ether("1") });
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "VaultIsDisconnecting")
        .withArgs(vaultAddress);
    });

    it("reverts if vault report is stale", async () => {
      await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(vaultAddress);
    });

    it("reverts if called for a healthy vault", async () => {
      await reportVault({ totalValue: ether("1") });
      await expect(
        vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }),
      ).to.be.revertedWithCustomError(vaultHub, "ForcedValidatorExitNotAllowed");
    });

    context("unhealthy vault", () => {
      beforeEach(async () => await makeVaultUnhealthy());

      it("reverts if the value on the vault is not enough to cover rebalance", async () => {
        await setBalance(vaultAddress, ether("0.9")); // 0.9 ETH is enough to cover rebalance

        await expect(
          vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: FEE }),
        ).to.be.revertedWithCustomError(vaultHub, "ForcedValidatorExitNotAllowed");
      });

      it("initiates force validator withdrawal when the value on the vault is enough to cover rebalance", async () => {
        await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: FEE }))
          .to.emit(vaultHub, "ForcedValidatorExitTriggered")
          .withArgs(vaultAddress, SAMPLE_PUBKEY, feeRecipient);
      });

      it("initiates force validator withdrawal with multiple pubkeys", async () => {
        const numPubkeys = 3;
        const pubkeys = "0x" + "ab".repeat(numPubkeys * 48);

        await expect(
          vaultHub.forceValidatorExit(vaultAddress, pubkeys, feeRecipient, { value: FEE * BigInt(numPubkeys) }),
        )
          .to.emit(vaultHub, "ForcedValidatorExitTriggered")
          .withArgs(vaultAddress, pubkeys, feeRecipient);
      });
    });

    // https://github.com/lidofinance/core/pull/933#discussion_r1954876831
    it("works for a synthetic example", async () => {
      const vaultCreationTx = (await vaultFactory
        .createVault(user, user, predepositGuarantee)
        .then((tx) => tx.wait())) as ContractTransactionReceipt;

      const events = findEvents(vaultCreationTx, "VaultCreated");
      const demoVaultAddress = events[0].args.vault;

      const demoVault = await ethers.getContractAt("StakingVault__MockForVaultHub", demoVaultAddress, user);

      const totalValue = ether("100");
      await demoVault.fund({ value: totalValue });
      const cap = await steth.getSharesByPooledEth((totalValue * (TOTAL_BASIS_POINTS - 20_00n)) / TOTAL_BASIS_POINTS);

      await operatorGridMock.changeVaultTierParams(demoVault, {
        shareLimit: cap,
        reserveRatioBP: 20_00n,
        forcedRebalanceThresholdBP: 20_00n,
        infraFeeBP: 5_00n,
        liquidityFeeBP: 4_00n,
        reservationFeeBP: 1_00n,
      });

      await demoVault.transferOwnership(vaultHub);
      await vaultHub.connectVault(demoVaultAddress);
      await reportVault({ targetVault: demoVault });
      await vaultHub.mintShares(demoVaultAddress, user, cap);

      expect((await vaultHub.vaultRecord(demoVaultAddress)).liabilityShares).to.equal(cap);

      // decrease totalValue to trigger rebase
      const penalty = ether("1");
      await reportVault({ targetVault: demoVault, totalValue: penalty });

      expect(await vaultHub.isVaultHealthy(demoVaultAddress)).to.be.false;

      await expect(vaultHub.forceValidatorExit(demoVaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: FEE }))
        .to.emit(vaultHub, "ForcedValidatorExitTriggered")
        .withArgs(demoVaultAddress, SAMPLE_PUBKEY, feeRecipient);
    });
  });
});
