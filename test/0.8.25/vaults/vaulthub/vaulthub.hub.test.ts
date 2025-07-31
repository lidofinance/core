import { expect } from "chai";
import { ContractTransactionReceipt, formatEther, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

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
  BigIntMath,
  certainAddress,
  ether,
  findEvents,
  GENESIS_FORK_VERSION,
  getCurrentBlockTimestamp,
  impersonate,
} from "lib";
import { MAX_FEE_BP, MAX_UINT256, TOTAL_BASIS_POINTS } from "lib/constants";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP, ZERO_HASH } from "test/suite";

const ZERO_BYTES32 = "0x" + Buffer.from(ZERO_HASH).toString("hex");

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

  let codehash: string;

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
    lidoFees,
    liabilityShares,
    slashingReserve,
  }: {
    vault: StakingVault__MockForVaultHub;
    reportTimestamp?: bigint;
    totalValue?: bigint;
    inOutDelta?: bigint;
    liabilityShares?: bigint;
    lidoFees?: bigint;
    slashingReserve?: bigint;
  }) {
    await lazyOracle.refreshReportTimestamp();
    const timestamp = await lazyOracle.latestReportTimestamp();

    totalValue = totalValue ?? (await vaultHub.totalValue(vault));
    const record = await vaultHub.vaultRecord(vault);
    const activeIndex = record.inOutDelta[0].refSlot >= record.inOutDelta[1].refSlot ? 0 : 1;
    inOutDelta = inOutDelta ?? record.inOutDelta[activeIndex].value;
    liabilityShares = liabilityShares ?? (await vaultHub.vaultRecord(vault)).liabilityShares;
    lidoFees = lidoFees ?? (await vaultHub.vaultObligations(vault)).unsettledLidoFees;
    slashingReserve = slashingReserve ?? 0n;

    await lazyOracle.mock__report(
      vaultHub,
      vault,
      timestamp,
      totalValue,
      inOutDelta,
      lidoFees,
      liabilityShares,
      slashingReserve,
    );
  }

  async function printRecord(vault: StakingVault__MockForVaultHub) {
    const record = await vaultHub.vaultRecord(vault);
    console.log("vaultRecord", {
      report: {
        totalValue: formatEther(record.report.totalValue),
        inOutDelta: formatEther(record.report.inOutDelta),
        timestamp: record.report.timestamp,
      },
      locked: formatEther(record.locked),
      shares: formatEther(record.liabilityShares),
      inOutDelta: {
        value: formatEther(record.inOutDelta[0].value),
        valueOnRefSlot: formatEther(record.inOutDelta[0].valueOnRefSlot),
        refSlot: record.inOutDelta[0].refSlot,
        value2: formatEther(record.inOutDelta[1].value),
        valueOnRefSlot2: formatEther(record.inOutDelta[1].valueOnRefSlot),
        refSlot2: record.inOutDelta[1].refSlot,
      },
    });
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
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_CODEHASH_SET_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract]);
    const beacon = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl, deployer]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [beacon]);
    const vault = await createVault(vaultFactory);

    codehash = keccak256(await ethers.provider.getCode(await vault.getAddress()));
    await vaultHub.connect(user).setAllowedCodehash(codehash, true);
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

  context("addVaultProxyCodehash", () => {
    it("reverts if called by non-VAULT_CODEHASH_SET_ROLE", async () => {
      await expect(vaultHub.connect(stranger).setAllowedCodehash(ZERO_BYTES32, true))
        .to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount")
        .withArgs(stranger, await vaultHub.VAULT_CODEHASH_SET_ROLE());
    });

    it("reverts if codehash is zero", async () => {
      await expect(vaultHub.connect(user).setAllowedCodehash(ZERO_BYTES32, true)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroArgument",
      );
    });

    it("reverts if the codehash is the keccak256 of empty string", async () => {
      const emptyStringHash = keccak256("0x");
      await expect(vaultHub.connect(user).setAllowedCodehash(emptyStringHash, true)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroCodehash",
      );
    });

    it("adds the codehash", async () => {
      const newCodehash = codehash.slice(0, -10) + "0000000000";
      await expect(vaultHub.setAllowedCodehash(newCodehash, true))
        .to.emit(vaultHub, "AllowedCodehashUpdated")
        .withArgs(newCodehash, true);
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
      expect(connection.pendingDisconnect).to.equal(false);
      expect(connection.reserveRatioBP).to.equal(0n);
      expect(connection.forcedRebalanceThresholdBP).to.equal(0n);
      expect(connection.infraFeeBP).to.equal(0n);
      expect(connection.liquidityFeeBP).to.equal(0n);
      expect(connection.reservationFeeBP).to.equal(0n);
      expect(connection.isBeaconDepositsManuallyPaused).to.equal(false);
    });

    it("returns the connection values if the vault is connected", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.vaultIndex).to.equal(await vaultHub.vaultsCount());
      expect(connection.owner).to.equal(user);
      expect(connection.pendingDisconnect).to.equal(false);
      expect(connection.shareLimit).to.equal(TIER_PARAMS.shareLimit);
      expect(connection.reserveRatioBP).to.equal(TIER_PARAMS.reserveRatioBP);
      expect(connection.forcedRebalanceThresholdBP).to.equal(TIER_PARAMS.forcedRebalanceThresholdBP);
      expect(connection.infraFeeBP).to.equal(TIER_PARAMS.infraFeeBP);
      expect(connection.liquidityFeeBP).to.equal(TIER_PARAMS.liquidityFeeBP);
      expect(connection.reservationFeeBP).to.equal(TIER_PARAMS.reservationFeeBP);
      expect(connection.isBeaconDepositsManuallyPaused).to.equal(false);
    });
  });

  context("vaultRecord", () => {
    it("returns zeroes if the vault is not connected", async () => {
      const vault = await createVault(vaultFactory);
      const record = await vaultHub.vaultRecord(vault);

      expect(record.report).to.deep.equal([0n, 0n, 0n]);
      expect(record.locked).to.equal(0n);
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
      expect(record.locked).to.equal(ether("1"));
      expect(record.liabilityShares).to.equal(0n);
      expect(record.inOutDelta).to.deep.equal([
        [ether("1"), 0n, 0n],
        [0n, 0n, 0n],
      ]);
    });
  });

  context("vaultObligations", () => {
    it("returns zeroes if the vault is not connected", async () => {
      const vault = await createVault(vaultFactory);
      const obligations = await vaultHub.vaultObligations(vault);

      expect(obligations).to.deep.equal([0n, 0n, 0n]);
    });

    it("returns the obligations if the vault is connected", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const unsettledLidoFees = 100n;
      await lazyOracle.mock__report(vaultHub, vault, 0n, 0n, 0n, unsettledLidoFees, 0n, 0n);
      const obligations = await vaultHub.vaultObligations(vault);

      expect(obligations).to.deep.equal([0n, unsettledLidoFees, 0n]);
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

    // Looks like fuzzing but it's not [:}
    it.skip("returns correct value for various parameters", async () => {
      const tbi = (n: number | bigint, min: number = 1) => BigInt(Math.floor(Math.random() * Number(n)) + min);

      for (let i = 0; i < 50; i++) {
        const snapshot = await Snapshot.take();
        const forcedRebalanceThresholdBP = tbi(10000);
        const reserveRatioBP = BigIntMath.min(forcedRebalanceThresholdBP + tbi(100), TOTAL_BASIS_POINTS - 1n);

        const totalValueEth = tbi(100);
        const totalValue = ether(totalValueEth.toString());

        const mintable = (totalValue * (TOTAL_BASIS_POINTS - reserveRatioBP)) / TOTAL_BASIS_POINTS;

        const isSlashing = Math.random() < 0.5;
        const slashed = isSlashing ? ether(tbi(totalValueEth).toString()) : 0n;
        const threshold =
          ((totalValue - slashed) * (TOTAL_BASIS_POINTS - forcedRebalanceThresholdBP)) / TOTAL_BASIS_POINTS;
        const expectedHealthy = threshold >= mintable;

        const { vault } = await createAndConnectVault(vaultFactory, {
          shareLimit: ether("100"), // just to bypass the share limit check
          reserveRatioBP,
          forcedRebalanceThresholdBP,
        });

        await vault.fund({ value: totalValue });

        await printRecord(vault);

        let sharesToMint = 0n;
        if (mintable > 0n) {
          sharesToMint = await lido.getSharesByPooledEth(mintable);
          await reportVault({ vault });
          await vaultHub.connect(user).mintShares(vault, user, sharesToMint);
          await printRecord(vault);
        }

        // simulate slashing
        await reportVault({
          vault,
          totalValue: totalValue - slashed,
          inOutDelta: totalValue,
          liabilityShares: sharesToMint,
        });
        console.log("vaultRecord", await vaultHub.vaultRecord(vault));

        try {
          const actualHealthy = await vaultHub.isVaultHealthy(vault);
          expect(actualHealthy).to.equal(expectedHealthy);
        } catch (error) {
          console.log(`Test failed with parameters:
            Rebalance Threshold: ${forcedRebalanceThresholdBP}
            Reserve Ratio: ${reserveRatioBP}
            Total Value: ${totalValue} ETH
            Minted: ${mintable} stETH
            Slashed: ${slashed} ETH
            Threshold: ${threshold} stETH
            Expected Healthy: ${expectedHealthy}
          `);
          throw error;
        }

        await Snapshot.restore(snapshot);
      }
    });

    it("returns correct value close to the threshold border cases at 1:1 share rate", async () => {
      const config = {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      };

      const { vault } = await createAndConnectVault(vaultFactory, config);

      const totalValue = ether("1");

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

      const totalValue = ether("1");
      const mintingEth = ether("0.5");
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

      await reportVault({ vault, totalValue: ether("1"), inOutDelta: ether("1") });

      const mintingEth = ether("0.4999");
      const sharesToMint = await lido.getSharesByPooledEth(mintingEth);
      await vaultHub.connect(user).mintShares(vault, user, sharesToMint);
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);

      // Burn some shares to make share rate fractional
      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("100"));
      await lido.connect(burner).burnShares(ether("100"));

      // update locked
      await reportVault({ vault });

      const lockedEth = (await vaultHub.vaultRecord(vault)).locked;

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

      await reportVault({ vault, totalValue: ether("1"), inOutDelta: ether("1") });

      await vaultHub.connect(user).mintShares(vault, user, 1n);

      await reportVault({ vault, totalValue: ether("1") });
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

  context("rebalanceShortfall", () => {
    it("does not revert when vault address is correct", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 10_00n, // 10%
      });

      await expect(vaultHub.rebalanceShortfall(vault)).not.to.be.reverted;
    });

    it("does not revert when vault address is ZeroAddress", async () => {
      const zeroAddress = ethers.ZeroAddress;
      await expect(vaultHub.rebalanceShortfall(zeroAddress)).not.to.be.reverted;
    });

    it("returns 0 when stETH was not minted", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
      });

      await reportVault({ vault, totalValue: ether("50"), inOutDelta: ether("50") });

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      expect(await vaultHub.rebalanceShortfall(vault)).to.equal(ether("0"));
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

      const burner = await impersonate(await locator.burner(), ether("1"));
      await lido.connect(whale).transfer(burner, ether("1"));
      await lido.connect(burner).burnShares(ether("1"));

      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.rebalanceShortfall(vault)).to.equal(0n);
    });

    it("different cases when vault is healthy, unhealthy and minted > totalValue", async () => {
      const { vault } = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 10_00n, // 10%
        forcedRebalanceThresholdBP: 9_00n, // 9%
      });

      await reportVault({ vault, totalValue: ether("1"), inOutDelta: ether("1") });

      await vaultHub.connect(user).mintShares(vault, user, ether("0.25"));

      await reportVault({ vault, totalValue: ether("0.5") }); // at the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.rebalanceShortfall(vault)).to.equal(0n);

      await reportVault({ vault, totalValue: ether("0.5") - 1n }); // below the threshold
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(true);
      expect(await vaultHub.rebalanceShortfall(vault)).to.equal(0n);

      await reportVault({ vault, totalValue: 0n }); // minted > totalValue
      expect(await vaultHub.isVaultHealthy(vault)).to.equal(false);
      expect(await vaultHub.rebalanceShortfall(vault)).to.equal(MAX_UINT256);
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
      const sharesByTotalValue = await lido.getSharesByPooledEth(await vaultHub.totalValue(vault));
      const shortfall = (record.liabilityShares * TOTAL_BASIS_POINTS - sharesByTotalValue * 50_00n) / 50_00n;
      expect(await vaultHub.rebalanceShortfall(vault)).to.equal(shortfall);
    });
  });

  context("connectVault", () => {
    let vault: StakingVault__MockForVaultHub;

    before(async () => {
      vault = await createVault(vaultFactory);
      await vault.connect(user).transferOwnership(vaultHub);
    });

    it("reverts if reserve ratio BP is zero", async () => {
      await operatorGridMock.changeVaultTierParams(vault, {
        shareLimit: 0n,
        reserveRatioBP: 0n,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vault)).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if reserve ratio is too high", async () => {
      const tooHighReserveRatioBP = TOTAL_BASIS_POINTS + 1n;

      await operatorGridMock.changeVaultTierParams(await vault.getAddress(), {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: tooHighReserveRatioBP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vault))
        .to.be.revertedWithCustomError(vaultHub, "InvalidBasisPoints")
        .withArgs(tooHighReserveRatioBP, TOTAL_BASIS_POINTS);
    });

    it("reverts if rebalance threshold BP is zero", async () => {
      await operatorGridMock.changeVaultTierParams(await vault.getAddress(), {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: 0n,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vault)).to.be.revertedWithCustomError(vaultHub, "ZeroArgument");
    });

    it("reverts if rebalance threshold BP is higher than reserve ratio BP", async () => {
      await operatorGridMock.changeVaultTierParams(await vault.getAddress(), {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: RESERVE_RATIO_BP + 1n,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await expect(vaultHub.connect(user).connectVault(vault))
        .to.be.revertedWithCustomError(vaultHub, "InvalidBasisPoints")
        .withArgs(RESERVE_RATIO_BP + 1n, RESERVE_RATIO_BP);
    });

    it("reverts if vault is already connected", async () => {
      const { vault: connectedVault } = await createAndConnectVault(vaultFactory);

      await expect(vaultHub.connect(user).connectVault(connectedVault))
        .to.be.revertedWithCustomError(vaultHub, "VaultHubNotPendingOwner")
        .withArgs(connectedVault);
    });

    it("reverts if proxy codehash is not added", async () => {
      const stakingVaultImpl2 = await ethers.deployContract("StakingVault__MockForVaultHub", [depositContract]);
      const beacon2 = await ethers.deployContract("UpgradeableBeacon", [stakingVaultImpl2, deployer]);

      const vaultFactory2 = await ethers.deployContract("VaultFactory__MockForVaultHub", [beacon2]);

      const vault2 = await createVault(vaultFactory2);
      await operatorGridMock.changeVaultTierParams(await vault2.getAddress(), {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO_BP,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD_BP,
        infraFeeBP: INFRA_FEE_BP,
        liquidityFeeBP: LIQUIDITY_FEE_BP,
        reservationFeeBP: RESERVATION_FEE_BP,
      });

      await vault2.connect(user).transferOwnership(vaultHub);
      await expect(vaultHub.connect(user).connectVault(vault2)).to.be.revertedWithCustomError(
        vaultHub,
        "CodehashNotAllowed",
      );
    });

    it("connects the vault", async () => {
      const vaultCountBefore = await vaultHub.vaultsCount();

      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.vaultIndex).to.equal(0n);
      expect(connection.pendingDisconnect).to.be.false;

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
      expect(connectionAfter.pendingDisconnect).to.be.false;
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
  });

  context("updateShareLimit", () => {
    let vault: StakingVault__MockForVaultHub;

    before(async () => {
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(vaultHub.connect(stranger).updateShareLimit(vault, SHARE_LIMIT)).to.be.revertedWithCustomError(
        vaultHub,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if vault address is zero", async () => {
      await expect(vaultHub.connect(user).updateShareLimit(ZeroAddress, SHARE_LIMIT)).to.be.revertedWithCustomError(
        vaultHub,
        "ZeroAddress",
      );
    });

    it("reverts if share limit exceeds the maximum vault limit", async () => {
      const insaneLimit = ether("1000000000000000000000000");
      const totalShares = await lido.getTotalShares();
      const maxRelativeShareLimitBP = VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP;
      const relativeShareLimitPerVault = (totalShares * maxRelativeShareLimitBP) / TOTAL_BASIS_POINTS;

      await expect(vaultHub.connect(user).updateShareLimit(vault, insaneLimit))
        .to.be.revertedWithCustomError(vaultHub, "ShareLimitTooHigh")
        .withArgs(insaneLimit, relativeShareLimitPerVault);
    });

    it("updates the share limit", async () => {
      const newShareLimit = SHARE_LIMIT + 100n;

      await expect(vaultHub.connect(user).updateShareLimit(vault, newShareLimit))
        .to.emit(vaultHub, "VaultShareLimitUpdated")
        .withArgs(vault, newShareLimit);

      const vaultSocket = await vaultHub.vaultConnection(vault);
      expect(vaultSocket.shareLimit).to.equal(newShareLimit);
    });
  });

  context("updateVaultFees", () => {
    let vault: StakingVault__MockForVaultHub;

    before(async () => {
      const { vault: _vault } = await createAndConnectVault(vaultFactory);
      vault = _vault;
    });

    it("reverts if called by non-VAULT_MASTER_ROLE", async () => {
      await expect(
        vaultHub.connect(stranger).updateVaultFees(vault, INFRA_FEE_BP, LIQUIDITY_FEE_BP, RESERVATION_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault address is zero", async () => {
      await expect(
        vaultHub.connect(user).updateVaultFees(ZeroAddress, INFRA_FEE_BP, LIQUIDITY_FEE_BP, RESERVATION_FEE_BP),
      ).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("reverts if infra fee is too high", async () => {
      const tooHighInfraFeeBP = MAX_FEE_BP + 1n;

      await expect(
        vaultHub.connect(user).updateVaultFees(vault, tooHighInfraFeeBP, LIQUIDITY_FEE_BP, RESERVATION_FEE_BP),
      )
        .to.be.revertedWithCustomError(vaultHub, "InvalidBasisPoints")
        .withArgs(tooHighInfraFeeBP, MAX_FEE_BP);
    });

    it("reverts if liquidity fee is too high", async () => {
      const tooHighLiquidityFeeBP = MAX_FEE_BP + 1n;

      await expect(
        vaultHub.connect(user).updateVaultFees(vault, INFRA_FEE_BP, tooHighLiquidityFeeBP, RESERVATION_FEE_BP),
      )
        .to.be.revertedWithCustomError(vaultHub, "InvalidBasisPoints")
        .withArgs(tooHighLiquidityFeeBP, MAX_FEE_BP);
    });

    it("reverts if reservation fee is too high", async () => {
      const tooHighReservationFeeBP = MAX_FEE_BP + 1n;

      await expect(
        vaultHub.connect(user).updateVaultFees(vault, INFRA_FEE_BP, LIQUIDITY_FEE_BP, tooHighReservationFeeBP),
      )
        .to.be.revertedWithCustomError(vaultHub, "InvalidBasisPoints")
        .withArgs(tooHighReservationFeeBP, MAX_FEE_BP);
    });

    it("updates the vault fees", async () => {
      const newInfraFeeBP = INFRA_FEE_BP * 2n;
      const newLiquidityFeeBP = LIQUIDITY_FEE_BP * 2n;
      const newReservationFeeBP = RESERVATION_FEE_BP * 2n;

      const connectionBefore = await vaultHub.vaultConnection(vault);
      await expect(vaultHub.connect(user).updateVaultFees(vault, newInfraFeeBP, newLiquidityFeeBP, newReservationFeeBP))
        .to.emit(vaultHub, "VaultFeesUpdated")
        .withArgs(
          vault,
          connectionBefore.infraFeeBP,
          connectionBefore.liquidityFeeBP,
          connectionBefore.reservationFeeBP,
          newInfraFeeBP,
          newLiquidityFeeBP,
          newReservationFeeBP,
        );

      const connection = await vaultHub.vaultConnection(vault);
      expect(connection.infraFeeBP).to.equal(newInfraFeeBP);
      expect(connection.liquidityFeeBP).to.equal(newLiquidityFeeBP);
      expect(connection.reservationFeeBP).to.equal(newReservationFeeBP);
    });
  });

  context("updateConnection", () => {
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

    it("update connection parameters", async () => {
      const { vault } = await createAndConnectVault(vaultFactory);
      const vaultAddress = await vault.getAddress();
      const operatorGridSigner = await impersonate(await operatorGridMock.getAddress(), ether("1"));

      const oldConnection = await vaultHub.vaultConnection(vaultAddress);
      const newInfraFeeBP = oldConnection.infraFeeBP + 10n;
      const newLiquidityFeeBP = oldConnection.liquidityFeeBP + 11n;
      const newReservationFeeBP = oldConnection.reservationFeeBP + 12n;

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
        .withArgs(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, FORCED_REBALANCE_THRESHOLD_BP)
        .to.emit(vaultHub, "VaultFeesUpdated")
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

    it("reverts if vault has shares minted", async () => {
      await vault.fund({ value: ether("1") });
      await reportVault({ vault });
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

      const vaultSocket = await vaultHub.vaultConnection(vault);
      expect(vaultSocket.pendingDisconnect).to.be.true;
    });

    it("clean quarantine after disconnect", async () => {
      await reportVault({ vault, totalValue: ether("1") });
      await expect(vaultHub.connect(user).disconnect(vault))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(vault);

      let vaultSocket = await vaultHub.vaultConnection(vault);
      expect(vaultSocket.pendingDisconnect).to.be.true;

      await lazyOracle.mock__setIsVaultQuarantined(vault, true);
      expect(await lazyOracle.isVaultQuarantined(vault)).to.equal(true);

      await expect(lazyOracle.mock__report(vaultHub, vault, 0n, 0n, 0n, 0n, 0n, 0n))
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
      await vault.fund({ value: ether("1") });
      await reportVault({ vault });
      await vaultHub.connect(user).mintShares(vaultAddress, user.address, 1n);

      await expect(vaultHub.connect(user).disconnect(vaultAddress)).to.be.revertedWithCustomError(
        vaultHub,
        "NoLiabilitySharesShouldBeLeft",
      );
    });

    it("disconnects the vault", async () => {
      await reportVault({ vault, totalValue: ether("1") });
      await expect(vaultHub.connect(user).disconnect(vaultAddress))
        .to.emit(vaultHub, "VaultDisconnectInitiated")
        .withArgs(vaultAddress);

      const vaultSocket = await vaultHub.vaultConnection(vaultAddress);
      expect(vaultSocket.pendingDisconnect).to.be.true;
    });
  });
});
