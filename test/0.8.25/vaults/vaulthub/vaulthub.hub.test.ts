import { expect } from "chai";
import { ContractTransactionReceipt, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  ACL,
  DepositContract__MockForVaultHub,
  LazyOracle__MockForVaultHub,
  Lido,
  LidoLocator,
  OperatorGrid,
  OperatorGrid__MockForVaultHub,
  OssifiableProxy,
  PredepositGuarantee__HarnessForFactory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";

import {
  advanceChainTime,
  certainAddress,
  days,
  ether,
  findEvents,
  GENESIS_FORK_VERSION,
  getCurrentBlockTimestamp,
  impersonate,
} from "lib";
import { DISCONNECT_NOT_INITIATED, MAX_UINT256, TOTAL_BASIS_POINTS } from "lib/constants";
import { ceilDiv } from "lib/protocol";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const TIER_PARAMS: TierParamsStruct = {
  shareLimit: ether("1"),
  reserveRatioBP: 10_00n,
  forcedRebalanceThresholdBP: 8_00n,
  infraFeeBP: 5_00n,
  liquidityFeeBP: 4_00n,
  reservationFeeBP: 1_00n,
};

const CONNECT_DEPOSIT = ether("1");

describe("VaultHub.sol:hub", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee__HarnessForFactory;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let depositContract: DepositContract__MockForVaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let lazyOracle: LazyOracle__MockForVaultHub;
  let lido: Lido;
  let acl: ACL;
  let operatorGrid: OperatorGrid;
  let operatorGridMock: OperatorGrid__MockForVaultHub;
  let proxy: OssifiableProxy;

  const SHARE_LIMIT = ether("100");
  const RESERVE_RATIO_BP = 10_00n;
  const FORCED_REBALANCE_THRESHOLD_BP = 8_00n;
  const INFRA_FEE_BP = 3_00n;
  const LIQUIDITY_FEE_BP = 1_00n;
  const RESERVATION_FEE_BP = 1_00n;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(user, user, predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    return ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
  }

  async function createAndConnectVault(factory: VaultFactory__MockForVaultHub, tierParams?: Partial<TierParamsStruct>) {
    const vault = await createVault(factory);
    await vault.connect(user).fund({ value: CONNECT_DEPOSIT });
    await operatorGridMock.changeVaultTierParams(vault, {
      ...TIER_PARAMS,
      ...tierParams,
    });
    await vault.connect(user).transferOwnership(vaultHub);
    const tx = await vaultHub.connect(user).connectVault(vault);

    return { vault, tx };
  }

  async function reportVault({
    vault,
    totalValue,
    inOutDelta,
    cumulativeLidoFees,
    liabilityShares,
    maxLiabilityShares,
    slashingReserve,
  }: {
    vault: StakingVault__MockForVaultHub;
    reportTimestamp?: bigint;
    totalValue?: bigint;
    inOutDelta?: bigint;
    liabilityShares?: bigint;
    maxLiabilityShares?: bigint;
    cumulativeLidoFees?: bigint;
    slashingReserve?: bigint;
  }) {
    await lazyOracle.refreshReportTimestamp();
    const timestamp = await lazyOracle.latestReportTimestamp();
    const record = await vaultHub.vaultRecord(vault);
    const activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;

    totalValue = totalValue ?? (await vaultHub.totalValue(vault));
    inOutDelta = inOutDelta ?? record.inOutDelta[activeIndex].value;
    liabilityShares = liabilityShares ?? record.liabilityShares;
    maxLiabilityShares = maxLiabilityShares ?? record.maxLiabilityShares;
    cumulativeLidoFees = cumulativeLidoFees ?? record.cumulativeLidoFees;
    slashingReserve = slashingReserve ?? 0n;

    await lazyOracle.mock__report(
      vaultHub,
      vault,
      timestamp,
      totalValue,
      inOutDelta,
      cumulativeLidoFees,
      liabilityShares,
      maxLiabilityShares,
      slashingReserve,
    );
  }

  before(async () => {
    [deployer, user, stranger, whale] = await ethers.getSigners();

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee__HarnessForFactory", [
      GENESIS_FORK_VERSION,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    ({ lido, acl } = await deployLidoDao({
      rootAccount: deployer,
      initialized: true,
      locatorConfig: { predepositGuarantee },
    }));

    locator = await ethers.getContractAt("LidoLocator", await lido.getLidoLocator(), deployer);

    await acl.createPermission(user, lido, await lido.RESUME_ROLE(), deployer);
    await acl.createPermission(user, lido, await lido.STAKING_CONTROL_ROLE(), deployer);

    await lido.connect(user).resume();
    await lido.connect(user).setMaxExternalRatioBP(TOTAL_BASIS_POINTS);

    await lido.connect(whale).submit(deployer, { value: ether("1000.0") });

    depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");

    // OperatorGrid
    operatorGridMock = await ethers.deployContract("OperatorGrid__MockForVaultHub", [], { from: deployer });
    operatorGrid = await ethers.getContractAt("OperatorGrid", operatorGridMock, deployer);
    await operatorGridMock.initialize(ether("1"));

    // LazyOracle
    lazyOracle = await ethers.deployContract("LazyOracle__MockForVaultHub");
    await lazyOracle.setLatestReportTimestamp(await getCurrentBlockTimestamp());

    await updateLidoLocatorImplementation(await locator.getAddress(), { operatorGrid, lazyOracle });

    // HashConsensus
    const hashConsensus = await ethers.deployContract("HashConsensus__MockForVaultHub");

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      await locator.lido(),
      hashConsensus,
      VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
    await vaultHubAdmin.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.RESUME_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract]);
    const beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [beacon]);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultFactory });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("Constants", () => {
    it("returns the STETH address", async () => {
      expect(await vaultHub.LIDO()).to.equal(await lido.getAddress());
    });
  });

  context("initialState", () => {
    it("returns the initial state", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(0);
    });
  });

  context("vaultsCount", () => {
    it("returns the number of connected vaults", async () => {
      expect(await vaultHub.vaultsCount()).to.equal(0);

      await createAndConnectVault(vaultFactory);

      expect(await vaultHub.vaultsCount()).to.equal(1);
    });
  });

  context("vaultByIndex", () => {
    it("reverts if index is out of bounds", async () => {
      await expect(vaultHub.vaultByIndex(100n)).to.be.reverted;
    });

    it("returns the vault", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const lastVaultId = await vaultHub.vaultsCount();

      expect(await vaultHub.vaultByIndex(lastVaultId)).to.equal(await vault.getAddress());
    });
  });

  context("vaultConnection", () => {
    it("returns zeroes if the vault is not connected", async () => {
      const vault = await createVault(vaultFactory);
      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.vaultIndex).to.equal(ZeroAddress);
      expect(connection.owner).to.equal(ZeroAddress);
      expect(connection.shareLimit).to.equal(0n);
      expect(connection.disconnectInitiatedTs).to.equal(0n);
      expect(connection.reserveRatioBP).to.equal(0n);
      expect(connection.forcedRebalanceThresholdBP).to.equal(0n);
      expect(connection.infraFeeBP).to.equal(0n);
      expect(connection.liquidityFeeBP).to.equal(0n);
      expect(connection.reservationFeeBP).to.equal(0n);
      expect(connection.beaconChainDepositsPauseIntent).to.equal(false);
    });

    it("returns the connection values if the vault is connected", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.vaultIndex).to.equal(await vaultHub.vaultsCount());
      expect(connection.owner).to.equal(user);
      expect(connection.disconnectInitiatedTs).to.equal(DISCONNECT_NOT_INITIATED);
      expect(connection.shareLimit).to.equal(TIER_PARAMS.shareLimit);
      expect(connection.reserveRatioBP).to.equal(TIER_PARAMS.reserveRatioBP);
      expect(connection.forcedRebalanceThresholdBP).to.equal(TIER_PARAMS.forcedRebalanceThresholdBP);
      expect(connection.infraFeeBP).to.equal(TIER_PARAMS.infraFeeBP);
      expect(connection.liquidityFeeBP).to.equal(TIER_PARAMS.liquidityFeeBP);
      expect(connection.reservationFeeBP).to.equal(TIER_PARAMS.reservationFeeBP);
      expect(connection.beaconChainDepositsPauseIntent).to.equal(false);
    });
  });

  context("vaultRecord", () => {
    it("returns zeroes if the vault is not connected", async () => {
      const vault = await createVault(vaultFactory);
      const record = await vaultHub.vaultRecord(vault);

      expect(record.report).to.deep.equal([0n, 0n, 0n]);
      expect(await vaultHub.locked(vault)).to.equal(0n);
      expect(record.liabilityShares).to.equal(0n);
      expect(record.inOutDelta).to.deep.equal([
        [0n, 0n, 0n],
        [0n, 0n, 0n],
      ]);
    });

    it("returns the record values if the vault is connected", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const record = await vaultHub.vaultRecord(vault);

      const timestamp = await getCurrentBlockTimestamp();
      expect(record.report).to.deep.equal([ether("1"), ether("1"), timestamp]);
      expect(await vaultHub.locked(vault)).to.equal(ether("1"));
      expect(record.liabilityShares).to.equal(0n);
      expect(record.inOutDelta).to.deep.equal([
        [ether("1"), 0n, 0n],
        [0n, 0n, 0n],
      ]);
    });
  });

  context("isVaultHealthy", () => {
    it("returns true if the vault is not connected", async () => {
      expect(await vaultHub.isVaultHealthy(certainAddress("random-vault"))).to.be.true;
    });

    it("returns true if the vault has no shares minted", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const vaultAddress = await vault.getAddress();

      await vault.fund({ value: ether("1") });

      expect(await vaultHub.isVaultHealthy(vaultAddress)).to.equal(true);
    });

    it("returns correct value close to the threshold border cases at 1:1 share rate", async () => {
      const config = {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      };

      const { vault } = await createAndConnectVault(vaultFactory, config);

      await vaultHub.connect(user).fund(vault, { value: ether("1") });
      const totalValue = ether("2");

      // steth/share = 1:1

      // no liability shares
      await reportVault({ vault, totalValue, inOutDelta: totalValue });
      expect((await vaultHub.vaultRecord(vault)).liabilityShares).to.equal(0n);
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      // max shares
      const maxLiabilityShares = (totalValue * config.reserveRatioBP) / TOTAL_BASIS_POINTS;
      await vaultHub.connect(user).mintShares(vault, user, maxLiabilityShares);
      expect(await lido.balanceOf(user)).to.equal(maxLiabilityShares);
      await reportVault({ vault, totalValue, inOutDelta: totalValue, liabilityShares: maxLiabilityShares });
      expect((await vaultHub.vaultRecord(vault)).liabilityShares).to.equal(maxLiabilityShares);
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      // totalValue decreased
      await reportVault({
        vault,
        totalValue: totalValue - 1n,
      });
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);

      // totalValue recovered
      await reportVault({
        vault,
        totalValue: totalValue,
      });
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
    });

    it("returns correct value for different share rates", async () => {
      const config = {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      };

      const { vault } = await createAndConnectVault(vaultFactory, config);

      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      const totalValue = ether("2"); // connect deposit + 1 ETH
      const mintingEth = ether("1");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await reportVault({ vault, totalValue, inOutDelta: totalValue });
      await vaultHub.connect(user).mintShares(vault, user, sharesToMint);
      expect(await lido.balanceOf(user)).to.equal(mintingEth);
      expect(await vaultHub.isVaultHealthy(vault)).to.be.true;

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      // make sure that 1 share is now worth more
      expect(await lido.getPooledEthByShares(ether("1"))).to.be.greaterThan(ether("1"));

      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false); // old totalValue is not enough

      const lockedEth = await lido.getPooledEthBySharesRoundUp(sharesToMint);
      // For 50% reserve ratio, we need totalValue to be 2x of locked ETH to be healthy
      const sufficientTotalValue = lockedEth * 2n;

      await reportVault({ vault, totalValue: sufficientTotalValue - 1n }); // below the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);

      await reportVault({ vault, totalValue: sufficientTotalValue }); // at the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      await reportVault({ vault, totalValue: sufficientTotalValue + 1n }); // above the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
    });

    it("returns correct value for smallest possible reserve ratio", async () => {
      const config = {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      };

      const { vault } = await createAndConnectVault(vaultFactory, config);

      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      await reportVault({ vault, totalValue: ether("2"), inOutDelta: ether("2") });

      const mintingEth = ether("1");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vault, user, sharesToMint);
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      // update locked
      await reportVault({ vault });

      const lockedEth = await vaultHub.locked(vault);

      await reportVault({ vault, totalValue: lockedEth });
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      await reportVault({ vault, totalValue: lockedEth - 1n }); // below the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);

      await reportVault({ vault, totalValue: lockedEth }); // at the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      await reportVault({ vault, totalValue: lockedEth + 1n }); // above the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
    });

    it("returns correct value for minimal shares amounts", async () => {
      const config = {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      };

      const { vault } = await createAndConnectVault(vaultFactory, config);

      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      await reportVault({ vault, totalValue: ether("2"), inOutDelta: ether("2") });

      await vaultHub.connect(user).mintShares(vault, user, 1n);

      await reportVault({ vault, totalValue: ether("2") });
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      await reportVault({ vault, totalValue: 2n }); // Minimal totalValue to be healthy with 1 share (50% reserve ratio)
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      await reportVault({ vault, totalValue: 1n }); // Below minimal required totalValue
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);

      await lido.connect(user).transferShares(await locator.vaultHub(), 1n);
      await vaultHub.connect(user).burnShares(vault, 1n);

      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true); // Should be healthy with no shares
    });

    it("healthy when totalValue is less than CONNECT_DEPOSIT", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 9_00n, // 9%
      });

      await reportVault({ vault, totalValue: ether("1"), inOutDelta: ether("1") });
      expect(await vaultHub.totalValue(vault)).to.equal(await vaultHub.CONNECT_DEPOSIT());
      expect(await vaultHub.isVaultHealthy(vault)).to.be.true; // true

      await reportVault({ vault, totalValue: ether("0.9"), inOutDelta: ether("1") });
      expect(await vaultHub.totalValue(vault)).to.be.lessThan(await vaultHub.CONNECT_DEPOSIT());
      expect(await vaultHub.isVaultHealthy(vault)).to.be.true;
    });
  });

  context("healthShortfallShares", () => {
    it("does not revert when vault address is correct", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 10_00n, // 10%
      });

      await expect(vaultHub.healthShortfallShares(vault)).not.to.be.reverted;
    });

    it("does not revert when vault address is ZeroAddress", async () => {
      const zeroAddress = ethers.ZeroAddress;
      await expect(vaultHub.healthShortfallShares(zeroAddress)).not.to.be.reverted;
    });

    it("returns 0 when stETH was not minted", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      });

      expect(await vaultHub.healthShortfallShares(vault)).to.equal(0n);
    });

    it("returns 0 when minted small amount of stETH and vault is healthy", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 9_00n, // 9%
      });

      await reportVault({ vault, totalValue: ether("50") });

      const mintingEth = ether("1");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vault, user, sharesToMint);

      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.healthShortfallShares(vault)).to.equal(0n);
    });

    it("different cases when vault is healthy, unhealthy and minted > totalValue", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 9_00n, // 9%
      });

      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      await reportVault({ vault, totalValue: ether("2"), inOutDelta: ether("2") });

      await vaultHub.connect(user).mintShares(vault, user, ether("0.25"));

      await reportVault({ vault, totalValue: ether("0.5") }); // at the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.healthShortfallShares(vault)).to.equal(0n);

      await reportVault({ vault, totalValue: ether("0.5") - 1n }); // below the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.healthShortfallShares(vault)).to.equal(0n);

      await reportVault({ vault, totalValue: 0n }); // minted > totalValue
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);
      expect(await vaultHub.healthShortfallShares(vault)).to.equal(MAX_UINT256);
    });

    it("returns correct value for rebalance vault", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      });

      await vaultHub.connect(user).fund(vault, { value: ether("49") });
      expect(await vaultHub.totalValue(vault)).to.equal(ether("50"));

      await reportVault({ vault, totalValue: ether("50") });

      const mintingEth = ether("25");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vault, user, sharesToMint);

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      await reportVault({ vault });

      const record = await vaultHub.vaultRecord(vault);

      const maxMintableRatio = TOTAL_BASIS_POINTS - 50_00n;
      const liabilityShares_ = record.liabilityShares;
      const liability = await lido.getPooledEthBySharesRoundUp(liabilityShares_);
      const totalValue_ = await vaultHub.totalValue(vault);

      const shortfallEth = ceilDiv(liability * TOTAL_BASIS_POINTS - totalValue_ * maxMintableRatio, 50_00n);
      const shortfallShares = (await lido.getSharesByPooledEth(shortfallEth)) + 100n;

      expect(await vaultHub.healthShortfallShares(vault)).to.equal(shortfallShares);
    });
  });

  context("obligationsShortfallValue", () => {
    it("does not revert when vault address is correct", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      });

      await expect(vaultHub.obligationsShortfallValue(vault)).not.to.be.reverted;
    });

    it("does not revert when vault address is ZeroAddress", async () => {
      const zeroAddress = ethers.ZeroAddress;
      await expect(vaultHub.obligationsShortfallValue(zeroAddress)).not.to.be.reverted;
    });

    it("different cases when vault is healthy, unhealthy and minted > totalValue, and fees are > MIN_BEACON_DEPOSIT", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 9_00n, // 9%
      });

      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      await reportVault({ vault, totalValue: ether("2"), inOutDelta: ether("2") });

      await vaultHub.connect(user).mintShares(vault, user, ether("0.25"));

      await reportVault({ vault, totalValue: ether("0.5") }); // at the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.obligationsShortfallValue(vault)).to.equal(0n);

      const balanceBefore = await ethers.provider.getBalance(vault);
      await setBalance(await vault.getAddress(), 0n);
      // below the threshold, but with fees
      await reportVault({ vault, totalValue: ether("0.5") - 1n, cumulativeLidoFees: ether("1") });
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.obligationsShortfallValue(vault)).to.equal(ether("1"));

      await setBalance(await vault.getAddress(), balanceBefore);
      await reportVault({ vault, totalValue: 0n }); // minted > totalValue
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);
      expect(await vaultHub.obligationsShortfallValue(vault)).to.equal(MAX_UINT256);
    });

    it("returns correct value for rebalance vault", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%s
        forcedRebalanceThresholdBP: 50_00n, // 50%
      });

      await vaultHub.connect(user).fund(vault, { value: ether("49") });
      expect(await vaultHub.totalValue(vault)).to.equal(ether("50"));

      await reportVault({ vault, totalValue: ether("50") });

      const mintingEth = ether("25");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vault, user, sharesToMint);

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      await reportVault({ vault });

      const record = await vaultHub.vaultRecord(vault);
      const maxMintableRatio = TOTAL_BASIS_POINTS - 50_00n;
      const liabilityShares_ = record.liabilityShares;
      const liability = await lido.getPooledEthBySharesRoundUp(liabilityShares_);
      const totalValue_ = await vaultHub.totalValue(vault);

      const shortfallEth = ceilDiv(liability * TOTAL_BASIS_POINTS - totalValue_ * maxMintableRatio, 50_00n);
      const shortfallShares = (await lido.getSharesByPooledEth(shortfallEth)) + 100n;

      expect(await vaultHub.healthShortfallShares(vault)).to.equal(shortfallShares);
    });
  });

  context("connectVault", () => {
    let vault: StakingVault__MockForVaultHub;

    before(async () => {
      vault = await createVault(vaultFactory);
      await vault.connect(user).transferOwnership(vaultHub);
    });

    it("reverts if called by non-owner", async () => {
      await expect(vaultHub.connect(stranger).connectVault(vault)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("reverts if vault is not factory deployed", async () => {
      const randomVault = certainAddress("randomVault");
      await expect(vaultHub.connect(user).connectVault(randomVault))
        .to.be.revertedWithCustomError(vaultHub, "VaultNotFactoryDeployed")
        .withArgs(randomVault);
    });

    it("reverts if vault is already connected", async () => {
      const { vault: connectedVault } = await createAndConnectVault(vaultFactory);

      await expect(vaultHub.connect(user).connectVault(connectedVault)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("connects the vault", async () => {
      const vaultCountBefore = await vaultHub.vaultsCount();

      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.vaultIndex).to.equal(0n);
      expect(await vaultHub.isPendingDisconnect(vault)).to.be.false;
      expect(await vaultHub.isVaultConnected(vault)).to.be.false;

      await vault.connect(user).fund({ value: ether("1") });

      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: SHARE_LIMIT, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(
          _vault,
          SHARE_LIMIT,
          RESERVE_RATIO_BP,
          FORCED_REBALANCE_THRESHOLD_BP,
          INFRA_FEE_BP,
          LIQUIDITY_FEE_BP,
          RESERVATION_FEE_BP,
        );

      expect(await vaultHub.vaultsCount()).to.equal(vaultCountBefore + 1n);

      const connectionAfter = await vaultHub.vaultConnection(_vault);
      expect(connectionAfter.vaultIndex).to.equal(vaultCountBefore + 1n);
      expect(connectionAfter.disconnectInitiatedTs).to.be.equal(DISCONNECT_NOT_INITIATED);
    });

    it("allows to connect the vault with 0 share limit", async () => {
      await vault.connect(user).fund({ value: ether("1") });

      await operatorGridMock.changeVaultTierParams(vault, {
        shareLimit: 0n,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: 0n, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(
          _vault,
          0n,
          RESERVE_RATIO_BP,
          FORCED_REBALANCE_THRESHOLD_BP,
          INFRA_FEE_BP,
          LIQUIDITY_FEE_BP,
          RESERVATION_FEE_BP,
        );
    });

    it("allows to connect the vault with 0 infra fee", async () => {
      await vault.connect(user).fund({ value: ether("1") });

      await operatorGridMock.changeVaultTierParams(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: 0n,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: SHARE_LIMIT, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: 0n,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(
          _vault,
          SHARE_LIMIT,
          RESERVE_RATIO_BP,
          FORCED_REBALANCE_THRESHOLD_BP,
          0n,
          LIQUIDITY_FEE_BP,
          RESERVATION_FEE_BP,
        );
    });
    it("allows to connect the vault with 0 liquidity fee", async () => {
      await vault.connect(user).fund({ value: ether("1") });

      await operatorGridMock.changeVaultTierParams(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: 0n,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: SHARE_LIMIT, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: 0n,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(
          _vault,
          SHARE_LIMIT,
          RESERVE_RATIO_BP,
          FORCED_REBALANCE_THRESHOLD_BP,
          INFRA_FEE_BP,
          0n,
          RESERVATION_FEE_BP,
        );
    });

    it("allows to connect the vault with 0 reservation fee", async () => {
      await vault.connect(user).fund({ value: ether("1") });

      await operatorGridMock.changeVaultTierParams(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: 0n,
      });

      const { vault: _vault, tx } = await createAndConnectVault(vaultFactory, {
        shareLimit: SHARE_LIMIT, // just to bypass the share limit check
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: 0n,
      });

      await expect(tx)
        .to.emit(vaultHub, "VaultConnected")
        .withArgs(
          _vault,
          SHARE_LIMIT,
          RESERVE_RATIO_BP,
          FORCED_REBALANCE_THRESHOLD_BP,
          INFRA_FEE_BP,
          LIQUIDITY_FEE_BP,
          0n,
        );
    });

    it("provision beacon deposits manually paused state from the vault", async () => {
      await vault.connect(user).fund({ value: ether("1") });

      expect(await vault.beaconChainDepositsPaused()).to.be.false;

      // change to non default value
      await expect(vault.connect(user).pauseBeaconChainDeposits()).to.emit(vault, "Mock__BeaconChainDepositsPaused");
      expect(await vault.beaconChainDepositsPaused()).to.be.true;

      await operatorGridMock.changeVaultTierParams(vault, {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: 0n,
      });

      await expect(vaultHub.connect(user).connectVault(vault)).to.emit(vaultHub, "VaultConnected");

      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.beaconChainDepositsPauseIntent).to.be.true;
    });
  });

  context("updateConnection", () => {
    let operatorGridSigner: HardhatEthersSigner;

    before(async () => {
      operatorGridSigner = await impersonate(await operatorGridMock.getAddress(), ether("1"));
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      await expect(
        vaultHub
          .connect(stranger)
          .updateConnection(
            vault,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            FORCED_REBALANCE_THRESHOLD_BP,
            INFRA_FEE_BP,
            LIQUIDITY_FEE_BP,
            RESERVATION_FEE_BP,
          ),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts if report is stale", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      await advanceChainTime(days(3n));

      await expect(
        vaultHub
          .connect(operatorGridSigner)
          .updateConnection(
            vault,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            FORCED_REBALANCE_THRESHOLD_BP,
            INFRA_FEE_BP,
            LIQUIDITY_FEE_BP,
            RESERVATION_FEE_BP,
          ),
      )
        .to.be.revertedWithCustomError(vaultHub, "VaultReportStale")
        .withArgs(vault);
    });

    it("update connection parameters", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const vaultAddress = await vault.getAddress();
      const nodeOperator = await vault.nodeOperator();

      const oldConnection = await vaultHub.vaultConnection(vaultAddress);
      const newInfraFeeBP = oldConnection.infraFeeBP + 10n;
      const newLiquidityFeeBP = oldConnection.liquidityFeeBP + 11n;
      const newReservationFeeBP = oldConnection.reservationFeeBP + 12n;

      await reportVault({ vault });

      await expect(
        vaultHub
          .connect(operatorGridSigner)
          .updateConnection(
            vaultAddress,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            FORCED_REBALANCE_THRESHOLD_BP,
            newInfraFeeBP,
            newLiquidityFeeBP,
            newReservationFeeBP,
          ),
      )
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(vaultAddress, nodeOperator, SHARE_LIMIT, RESERVE_RATIO_BP, FORCED_REBALANCE_THRESHOLD_BP)
        .and.to.emit(vaultHub, "VaultFeesUpdated")
        .withArgs(
          vaultAddress,
          oldConnection.infraFeeBP,
          oldConnection.liquidityFeeBP,
          oldConnection.reservationFeeBP,
          newInfraFeeBP,
          newLiquidityFeeBP,
          newReservationFeeBP,
        );
    });

    it("reverts if minting capacity would be breached", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);

      await vaultHub.connect(user).fund(vault, { value: ether("1") });
      await vaultHub.connect(user).mintShares(vault, user.address, 1n);

      await expect(
        vaultHub.connect(operatorGridSigner).updateConnection(
          vault,
          SHARE_LIMIT,
          10000n, // 100% reserve ratio
          FORCED_REBALANCE_THRESHOLD_BP,
          INFRA_FEE_BP,
          LIQUIDITY_FEE_BP,
          RESERVATION_FEE_BP,
        ),
      ).to.be.revertedWithCustomError(vaultHub, "VaultMintingCapacityExceeded");
    });

    context("for unhealthy vaults", () => {
      let vault: StakingVault__MockForVaultHub;

      before(async () => {
        ({ vault } = await createAndConnectVault(vaultFactory, {
          infraFeeBP: INFRA_FEE_BP,
          liquidityFeeBP: LIQUIDITY_FEE_BP,
          reservationFeeBP: RESERVATION_FEE_BP,
        }));

        await vaultHub.connect(user).fund(vault, { value: ether("1") });
        await vaultHub.connect(user).mintShares(vault, user.address, ether("0.9"));
        await reportVault({ vault, totalValue: ether("0.9") });

        expect(await vaultHub.isVaultHealthy(vault)).to.be.false;
      });

      it("reverts if minting capacity would be breached (by forced rebalance threshold)", async () => {
        await expect(
          vaultHub.connect(operatorGridSigner).updateConnection(
            vault,
            SHARE_LIMIT,
            RESERVE_RATIO_BP,
            10000n, // 100% forced rebalance threshold
            INFRA_FEE_BP,
            LIQUIDITY_FEE_BP,
            RESERVATION_FEE_BP,
          ),
        ).to.be.revertedWithCustomError(vaultHub, "VaultMintingCapacityExceeded");
      });

      it("allows to set share limit and fees even on the unhealthy vault", async () => {
        await expect(
          vaultHub
            .connect(operatorGridSigner)
            .updateConnection(
              vault,
              SHARE_LIMIT + 1n,
              RESERVE_RATIO_BP,
              FORCED_REBALANCE_THRESHOLD_BP,
              INFRA_FEE_BP + 1n,
              LIQUIDITY_FEE_BP + 1n,
              RESERVATION_FEE_BP + 1n,
            ),
        )
          .to.to.emit(vaultHub, "VaultConnectionUpdated")
          .withArgs(vault, user.address, SHARE_LIMIT + 1n, RESERVE_RATIO_BP, FORCED_REBALANCE_THRESHOLD_BP)
          .and.to.emit(vaultHub, "VaultFeesUpdated")
          .withArgs(
            vault,
            INFRA_FEE_BP,
            LIQUIDITY_FEE_BP,
            RESERVATION_FEE_BP,
            INFRA_FEE_BP + 1n,
            LIQUIDITY_FEE_BP + 1n,
            RESERVATION_FEE_BP + 1n,
          );
      });
    });
  });

  context("disconnect", () => {
    let vault: StakingVault__MockForVaultHub;

    before(async () => {
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(vaultHub.connect(stranger).disconnect(vault)).to.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if vault address is zero", async () => {
      await expect(vaultHub.connect(user).disconnect(ZeroAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroAddress",
      );
    });

    it("reverts if vault is not connected", async () => {
      await expect(vaultHub.connect(user).disconnect(certainAddress("random"))).to.be.revertedWithCustomError(
        vaultHub,
        "NotConnectedToHub",
      );
    });

    it("reverts if report is stale", async () => {
      await advanceChainTime(days(3n));

      await expect(vaultHub.connect(user).disconnect(vault)).to.be.revertedWithCustomError(
        vaultHub,
        "VaultReportStale",
      );
    });

    it("reverts if vault has shares minted", async () => {
      await vaultHub.connect(user).fund(vault, { value: ether("1") });
      await vaultHub.connect(user).mintShares(vault, user.address, 1n);

      await expect(vaultHub.connect(user).disconnect(vault)).to.be.revertedWithCustomError(
        vaultHub,
        "NoLiabilitySharesShouldBeLeft",
      );
    });

    it("initiates the disconnect process", async () => {
      await reportVault({ vault, totalValue: ether("1") });
      await expect(vaultHub.connect(user).disconnect(vault))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(vault);

      expect(await vaultHub.isPendingDisconnect(vault)).to.be.true;
    });

    it("clean quarantine after disconnect", async () => {
      await reportVault({ vault, totalValue: ether("1") });
      await expect(vaultHub.connect(user).disconnect(vault))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(vault);

      let vaultSocket = await vaultHub.vaultConnection(vault);
      expect(await vaultHub.isPendingDisconnect(vault)).to.be.true;

      await lazyOracle.mock__setIsVaultQuarantined(vault, true);
      expect(await lazyOracle.isVaultQuarantined(vault)).to.equal(true);

      await expect(lazyOracle.mock__report(vaultHub, vault, await getCurrentBlockTimestamp(), 0n, 0n, 0n, 0n, 0n, 0n))
        .to.emit(vaultHub, "VaultDisconnectCompleted")
        .withArgs(vault);

      expect(await lazyOracle.isVaultQuarantined(vault)).to.equal(false);

      vaultSocket = await vaultHub.vaultConnection(vault);
      expect(vaultSocket.vaultIndex).to.equal(0); // vault is disconnected
    });
  });

  context("voluntaryDisconnect", () => {
    let vault: StakingVault__MockForVaultHub;
    let vaultAddress: string;

    before(async () => {
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
      vaultAddress = await vault.getAddress();
    });

    it("reverts if minting paused", async () => {
      await vaultHub.connect(user).pauseFor(1000n);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ResumedExpected",
      );
    });

    it("reverts if vault is zero address", async () => {
      await expect(vaultHub.connect(user).voluntaryDisconnect(ZeroAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroAddress",
      );
    });

    it("reverts if called as non-vault owner", async () => {
      await expect(vaultHub.connect(stranger).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("reverts if vault is not connected", async () => {
      const testVault = await createVault(vaultFactory);

      await expect(vaultHub.connect(user).voluntaryDisconnect(testVault))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(testVault);
    });

    it("reverts if vault has shares minted", async () => {
      await vaultHub.connect(user).fund(vault, { value: ether("1") });
      await vaultHub.connect(user).mintShares(vaultAddress, user.address, 1n);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoLiabilitySharesShouldBeLeft",
      );
    });

    it("reverts if unsettled lido fees are greater than the balance", async () => {
      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      const totalValue = await vaultHub.totalValue(vaultAddress);
      const cumulativeLidoFees = totalValue - 1n;
      await reportVault({ vault, totalValue, cumulativeLidoFees });

      await setBalance(vaultAddress, cumulativeLidoFees - 1n);

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoUnsettledLidoFeesShouldBeLeft",
      );
    });

    it("reverts if unsettled lido fees are greater than the total value", async () => {
      await vaultHub.connect(user).fund(vault, { value: ether("1") });

      const totalValue = await vaultHub.totalValue(vaultAddress);
      const cumulativeLidoFees = totalValue + 1n;
      await reportVault({ vault, totalValue, cumulativeLidoFees });

      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoUnsettledLidoFeesShouldBeLeft",
      );
    });

    it("disconnects the vault", async () => {
      await expect(vaultHub.connect(user).voluntaryDisconnect(vaultAddress))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(vaultAddress);

      expect(await vaultHub.isPendingDisconnect(vaultAddress)).to.be.true;
    });
  });

  context("collect erc20", () => {
    let vault: StakingVault__MockForVaultHub;

    before(async () => {
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
    });

    it("reverts on non-owner call", async () => {
      await expect(
        vaultHub.connect(stranger).collectERC20FromVault(vault, certainAddress("erc20"), certainAddress("to"), 1n),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("passes call to the vault", async () => {
      const tx = await vaultHub
        .connect(user)
        .collectERC20FromVault(vault, certainAddress("erc20"), certainAddress("to"), 1n);
      await expect(tx.wait())
        .to.emit(vault, "Mock_Collected")
        .withArgs(certainAddress("erc20"), certainAddress("to"), 1n);
    });
  });

  context("applyVaultReport", () => {
    it("reverts if called by non LazyOracle", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      await expect(
        vaultHub.connect(stranger).applyVaultReport(vault, 1n, 1n, 1n, 1n, 1n, 1n, 1n),
      ).to.be.revertedWithCustomError(vaultHub, "NotAuthorized");
    });

    it("reverts if vault is not connected", async () => {
      await lazyOracle.refreshReportTimestamp();
      const { vault } = await createAndConnectVault(vaultFactory);

      await vaultHub.connect(user).disconnect(vault);
      await reportVault({ vault });
      expect(await vaultHub.isVaultConnected(vault)).to.be.false;

      await expect(reportVault({ vault })).to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub");
    });
  });
});
