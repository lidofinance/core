import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  PredepositGuarantee__HarnessForFactory,
  StakingVault__MockForOperatorGrid,
  StETH__MockForOperatorGrid,
  VaultHub,
  VaultHub__MockForOperatorGrid,
  WstETH__Harness,
} from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";

import {
  certainAddress,
  DISCONNECT_NOT_INITIATED,
  ether,
  GENESIS_FORK_VERSION,
  getNextBlockTimestamp,
  impersonate,
  MAX_FEE_BP,
  MAX_RESERVE_RATIO_BP,
} from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const DEFAULT_TIER_SHARE_LIMIT = ether("1000");
const RESERVE_RATIO = 2000;
const FORCED_REBALANCE_THRESHOLD = 1800;
const INFRA_FEE = 500;
const LIQUIDITY_FEE = 400;
const RESERVATION_FEE = 100;

describe("OperatorGrid.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let vaultHubAsSigner: HardhatEthersSigner;

  let nodeOperator1: HardhatEthersSigner;
  let nodeOperator2: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee__HarnessForFactory;
  let locator: LidoLocator;
  let steth: StETH__MockForOperatorGrid;
  let wsteth: WstETH__Harness;
  let vaultHub: VaultHub__MockForOperatorGrid;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;
  let vault_NO1_V1: StakingVault__MockForOperatorGrid;
  let vault_NO1_V2: StakingVault__MockForOperatorGrid;
  let vault_NO2_V1: StakingVault__MockForOperatorGrid;
  let vault_NO2_V2: StakingVault__MockForOperatorGrid;

  let originalState: string;

  const record: Readonly<VaultHub.VaultRecordStruct> = {
    report: {
      totalValue: 1000n,
      inOutDelta: 1000n,
      timestamp: 2122n,
    },
    liabilityShares: 555n,
    maxLiabilityShares: 1000n,
    inOutDelta: [
      {
        value: 1000n,
        valueOnRefSlot: 1000n,
        refSlot: 1n,
      },
      {
        value: 0n,
        valueOnRefSlot: 0n,
        refSlot: 0n,
      },
    ],
    minimalReserve: 0n,
    redemptionShares: 0n,
    cumulativeLidoFees: 0n,
    settledLidoFees: 0n,
  };

  before(async () => {
    [deployer, vaultOwner, stranger, nodeOperator1, nodeOperator2] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForOperatorGrid");
    wsteth = await ethers.deployContract("WstETH__Harness", [steth]);

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee__HarnessForFactory", [
      GENESIS_FORK_VERSION,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    locator = await deployLidoLocator({ lido: steth, wstETH: wsteth, predepositGuarantee });

    vault_NO1_V1 = await ethers.deployContract("StakingVault__MockForOperatorGrid", [vaultOwner, nodeOperator1]);
    vault_NO1_V2 = await ethers.deployContract("StakingVault__MockForOperatorGrid", [vaultOwner, nodeOperator1]);

    vault_NO2_V1 = await ethers.deployContract("StakingVault__MockForOperatorGrid", [vaultOwner, nodeOperator2]);
    vault_NO2_V2 = await ethers.deployContract("StakingVault__MockForOperatorGrid", [vaultOwner, nodeOperator2]);

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, deployer, new Uint8Array()], deployer);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, deployer);

    const defaultTierParams = {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO,
      forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD,
      infraFeeBP: INFRA_FEE,
      liquidityFeeBP: LIQUIDITY_FEE,
      reservationFeeBP: RESERVATION_FEE,
    };
    await operatorGrid.initialize(deployer, defaultTierParams);
    await operatorGrid.grantRole(await operatorGrid.REGISTRY_ROLE(), deployer);

    // VaultHub
    vaultHub = await ethers.deployContract("VaultHub__MockForOperatorGrid", []);

    await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: 2000,
      forcedRebalanceThresholdBP: 1800,
      infraFeeBP: 500,
      liquidityFeeBP: 400,
      reservationFeeBP: 100,
      owner: vaultOwner,
      vaultIndex: 1,
      beaconChainDepositsPauseIntent: false,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
    });
    await vaultHub.mock__setVaultConnection(vault_NO1_V2, {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: 2000,
      forcedRebalanceThresholdBP: 1800,
      infraFeeBP: 500,
      liquidityFeeBP: 400,
      reservationFeeBP: 100,
      owner: vaultOwner,
      vaultIndex: 2,
      beaconChainDepositsPauseIntent: false,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
    });
    await vaultHub.mock__setVaultConnection(vault_NO2_V1, {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: 2000,
      forcedRebalanceThresholdBP: 1800,
      infraFeeBP: 500,
      liquidityFeeBP: 400,
      reservationFeeBP: 100,
      owner: vaultOwner,
      vaultIndex: 3,
      beaconChainDepositsPauseIntent: false,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
    });
    await vaultHub.mock__setVaultConnection(vault_NO2_V2, {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: 2000,
      forcedRebalanceThresholdBP: 1800,
      infraFeeBP: 500,
      liquidityFeeBP: 400,
      reservationFeeBP: 100,
      owner: vaultOwner,
      vaultIndex: 4,
      beaconChainDepositsPauseIntent: false,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
    });

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    vaultHubAsSigner = await impersonate(await vaultHub.getAddress(), ether("100.0"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on impl initialization", async () => {
      const defaultTierParams = {
        shareLimit: DEFAULT_TIER_SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD,
        infraFeeBP: INFRA_FEE,
        liquidityFeeBP: LIQUIDITY_FEE,
        reservationFeeBP: RESERVATION_FEE,
      };
      await expect(operatorGrid.initialize(stranger, defaultTierParams)).to.be.revertedWithCustomError(
        operatorGridImpl,
        "InvalidInitialization",
      );
    });
    it("reverts on `_admin` address is zero", async () => {
      const operatorGridProxy = await ethers.deployContract(
        "OssifiableProxy",
        [operatorGridImpl, deployer, new Uint8Array()],
        deployer,
      );
      const operatorGridLocal = await ethers.getContractAt("OperatorGrid", operatorGridProxy, deployer);
      const defaultTierParams = {
        shareLimit: DEFAULT_TIER_SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD,
        infraFeeBP: INFRA_FEE,
        liquidityFeeBP: LIQUIDITY_FEE,
        reservationFeeBP: RESERVATION_FEE,
      };
      await expect(operatorGridLocal.initialize(ZeroAddress, defaultTierParams))
        .to.be.revertedWithCustomError(operatorGridImpl, "ZeroArgument")
        .withArgs("_admin");
    });
    it("reverts on invalid `_defaultTierParams`", async () => {
      const operatorGridProxy = await ethers.deployContract(
        "OssifiableProxy",
        [operatorGridImpl, deployer, new Uint8Array()],
        deployer,
      );
      const operatorGridLocal = await ethers.getContractAt("OperatorGrid", operatorGridProxy, deployer);
      const defaultTierParams = {
        shareLimit: DEFAULT_TIER_SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO + 10,
        forcedRebalanceThresholdBP: RESERVE_RATIO,
        infraFeeBP: INFRA_FEE,
        liquidityFeeBP: LIQUIDITY_FEE,
        reservationFeeBP: RESERVATION_FEE,
      };
      await expect(operatorGridLocal.initialize(stranger, defaultTierParams))
        .to.be.revertedWithCustomError(operatorGridLocal, "ForcedRebalanceThresholdTooHigh")
        .withArgs("0", RESERVE_RATIO, RESERVE_RATIO + 10);
    });
  });

  context("Groups", () => {
    it("reverts on_nodeOperator address is zero", async function () {
      await expect(operatorGrid.registerGroup(ZeroAddress, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "ZeroArgument",
      );
    });

    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      await expect(operatorGrid.connect(stranger).registerGroup(ZeroAddress, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if group exists", async function () {
      const groupOperator = certainAddress("new-operator-group");
      await operatorGrid.registerGroup(groupOperator, 1000);

      await expect(operatorGrid.registerGroup(groupOperator, 1000)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupExists",
      );
    });

    it("reverts on updateGroupShareLimit when _nodeOperator address is zero", async function () {
      await expect(operatorGrid.updateGroupShareLimit(ZeroAddress, 1000)).to.be.revertedWithCustomError(
        operatorGrid,
        "ZeroArgument",
      );
    });

    it("reverts on updateGroupShareLimit when _nodeOperator not exists", async function () {
      await expect(
        operatorGrid.updateGroupShareLimit(certainAddress("non-existent-group"), 1000),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupNotExists");
    });

    it("add a new group", async function () {
      const groupOperator = certainAddress("new-operator-group");
      const shareLimit = 2001;

      await expect(operatorGrid.registerGroup(groupOperator, shareLimit))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(groupOperator, shareLimit);

      const groupStruct = await operatorGrid.group(groupOperator);

      expect(groupStruct.shareLimit).to.equal(shareLimit);
      expect(groupStruct.liabilityShares).to.equal(0);
      expect(groupStruct.tierIds.length).to.equal(0);
    });

    it("reverts when updating without `REGISTRY_ROLE` role", async function () {
      const nonExistentGroupId = certainAddress("non-existent-group");
      await expect(
        operatorGrid.connect(stranger).updateGroupShareLimit(nonExistentGroupId, 2),
      ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
    });

    it("update group share limit", async function () {
      const groupOperator = certainAddress("new-operator-group");
      const shareLimit = 2000;
      const newShareLimit = 9999;

      await expect(operatorGrid.registerGroup(groupOperator, shareLimit))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(groupOperator, shareLimit);

      await expect(operatorGrid.updateGroupShareLimit(groupOperator, newShareLimit))
        .to.emit(operatorGrid, "GroupShareLimitUpdated")
        .withArgs(groupOperator, newShareLimit);

      const groupStruct = await operatorGrid.group(groupOperator);
      expect(groupStruct.shareLimit).to.equal(newShareLimit);
    });

    it("update multiple groups share limits", async function () {
      const groupOperator1 = certainAddress("new-operator-group-1");
      const groupOperator2 = certainAddress("new-operator-group-2");
      const shareLimit1 = 2000;
      const shareLimit2 = 3000;
      const newShareLimit1 = 5000;
      const newShareLimit2 = 6000;

      await operatorGrid.registerGroup(groupOperator1, shareLimit1);
      await operatorGrid.registerGroup(groupOperator2, shareLimit2);

      await expect(operatorGrid.updateGroupShareLimit(groupOperator1, newShareLimit1))
        .to.emit(operatorGrid, "GroupShareLimitUpdated")
        .withArgs(groupOperator1, newShareLimit1);

      await expect(operatorGrid.updateGroupShareLimit(groupOperator2, newShareLimit2))
        .to.emit(operatorGrid, "GroupShareLimitUpdated")
        .withArgs(groupOperator2, newShareLimit2);

      const groupStruct1 = await operatorGrid.group(groupOperator1);
      const groupStruct2 = await operatorGrid.group(groupOperator2);
      expect(groupStruct1.shareLimit).to.equal(newShareLimit1);
      expect(groupStruct2.shareLimit).to.equal(newShareLimit2);
    });

    it("nodeOperatorCount - works", async function () {
      expect(await operatorGrid.nodeOperatorCount()).to.equal(0);

      const groupOperator = certainAddress("new-operator-group");
      await operatorGrid.registerGroup(groupOperator, 1000);

      expect(await operatorGrid.nodeOperatorCount()).to.equal(1);
    });

    it("nodeOperatorAddress - works", async function () {
      const groupOperator = certainAddress("new-operator-group");
      await operatorGrid.registerGroup(groupOperator, 1000);

      expect(await operatorGrid.nodeOperatorAddress(0)).to.equal(groupOperator);
    });

    it("nodeOperatorAddress - not exists", async function () {
      await expect(operatorGrid.nodeOperatorAddress(1)).to.be.revertedWithCustomError(
        operatorGrid,
        "NodeOperatorNotExists",
      );
    });
  });

  context("Tiers", () => {
    const groupOperator = certainAddress("new-operator-group");
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const infraFee = 500;
    const liquidityFee = 400;
    const reservationFee = 100;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        infraFeeBP: infraFee,
        liquidityFeeBP: liquidityFee,
        reservationFeeBP: reservationFee,
      },
    ];

    it("reverts if tier id is not exists with custom error", async function () {
      const tierCount = await operatorGrid.tiersCount();
      await expect(operatorGrid.tier(tierCount)).to.be.revertedWithCustomError(operatorGrid, "TierNotExists");
    });

    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      await expect(operatorGrid.connect(stranger).registerTiers(groupOperator, tiers)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if group does not exist", async function () {
      await expect(operatorGrid.registerTiers(groupOperator, tiers)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupNotExists",
      );
    });

    it("reverts if group operator is zero address", async function () {
      await expect(operatorGrid.registerTiers(ZeroAddress, tiers))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_nodeOperator");
    });

    it("reverts if the reserve ratio is 10_000", async function () {
      await expect(operatorGrid.registerTiers(ZeroAddress, tiers))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_nodeOperator");
    });

    it("works", async function () {
      await expect(operatorGrid.alterTiers([0], [tiers[0]]))
        .to.emit(operatorGrid, "TierUpdated")
        .withArgs(0, tierShareLimit, reserveRatio, forcedRebalanceThreshold, infraFee, liquidityFee, reservationFee);
    });

    it("tierCount - works", async function () {
      //default tier
      expect(await operatorGrid.tiersCount()).to.equal(1);

      await operatorGrid.registerGroup(groupOperator, 1000);
      await operatorGrid.registerTiers(groupOperator, tiers);

      expect(await operatorGrid.tiersCount()).to.equal(2);
    });
  });

  context("Validate Tier Params", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const infraFee = 500;
    const liquidityFee = 400;
    const reservationFee = 100;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        infraFeeBP: infraFee,
        liquidityFeeBP: liquidityFee,
        reservationFeeBP: reservationFee,
      },
    ];

    it("alterTiers - reverts if tier id is not exists", async function () {
      await expect(operatorGrid.alterTiers([2], [tiers[0]])).to.be.revertedWithCustomError(
        operatorGrid,
        "TierNotExists",
      );
    });

    it("alterTiers - validateParams - reverts if reserveRatioBP is less than 0", async function () {
      await expect(operatorGrid.alterTiers([0], [{ ...tiers[0], reserveRatioBP: 0 }]))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_reserveRatioBP");
    });

    it("alterTiers - validateParams - reverts if reserveRatioBP exceeds max", async function () {
      const _reserveRatioBP = MAX_RESERVE_RATIO_BP + 1n;
      await expect(operatorGrid.alterTiers([0], [{ ...tiers[0], reserveRatioBP: _reserveRatioBP }]))
        .to.be.revertedWithCustomError(operatorGrid, "ReserveRatioTooHigh")
        .withArgs("0", _reserveRatioBP, MAX_RESERVE_RATIO_BP);
    });

    it("alterTiers - validateParams - reverts if _rebalanceThresholdBP is zero", async function () {
      await expect(operatorGrid.alterTiers([0], [{ ...tiers[0], forcedRebalanceThresholdBP: 0 }]))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_forcedRebalanceThresholdBP");
    });

    it("alterTiers - validateParams - reverts if _rebalanceThresholdBP is greater than _reserveRatioBP", async function () {
      const _reserveRatioBP = 2000;
      const _forcedRebalanceThresholdBP = 2100;
      await expect(
        operatorGrid.alterTiers(
          [0],
          [
            {
              ...tiers[0],
              forcedRebalanceThresholdBP: _forcedRebalanceThresholdBP,
              reserveRatioBP: _reserveRatioBP,
            },
          ],
        ),
      )
        .to.be.revertedWithCustomError(operatorGrid, "ForcedRebalanceThresholdTooHigh")
        .withArgs("0", _forcedRebalanceThresholdBP, _reserveRatioBP);
    });

    it("alterTiers - validateParams - reverts if _infraFeeBP is greater than MAX_FEE_BP", async function () {
      const _infraFeeBP = MAX_FEE_BP + 1n;
      await expect(operatorGrid.alterTiers([0], [{ ...tiers[0], infraFeeBP: _infraFeeBP }]))
        .to.be.revertedWithCustomError(operatorGrid, "InfraFeeTooHigh")
        .withArgs("0", _infraFeeBP, MAX_FEE_BP);
    });

    it("alterTiers - validateParams - reverts if _liquidityFeeBP is greater than 100_00", async function () {
      const _liquidityFeeBP = MAX_FEE_BP + 1n;
      await expect(operatorGrid.alterTiers([0], [{ ...tiers[0], liquidityFeeBP: _liquidityFeeBP }]))
        .to.be.revertedWithCustomError(operatorGrid, "LiquidityFeeTooHigh")
        .withArgs("0", _liquidityFeeBP, MAX_FEE_BP);
    });

    it("alterTiers - validateParams - reverts if _reservationFeeBP is greater than 100_00", async function () {
      const _reservationFeeBP = MAX_FEE_BP + 1n;
      await expect(operatorGrid.alterTiers([0], [{ ...tiers[0], reservationFeeBP: _reservationFeeBP }]))
        .to.be.revertedWithCustomError(operatorGrid, "ReservationFeeTooHigh")
        .withArgs("0", _reservationFeeBP, MAX_FEE_BP);
    });

    it("alterTiers - reverts if arrays length mismatch", async function () {
      await expect(operatorGrid.alterTiers([0, 1], [tiers[0]])).to.be.revertedWithCustomError(
        operatorGrid,
        "ArrayLengthMismatch",
      );
    });

    it("alterTiers - updates multiple tiers at once", async function () {
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: 1000,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();
      const tier1Id = 1;

      const newShareLimit1 = 2000;
      const newReserveRatio1 = 3000;
      const newShareLimit2 = 3000;
      const newReserveRatio2 = 4000;

      await expect(
        operatorGrid.alterTiers(
          [defaultTierId, tier1Id],
          [
            {
              shareLimit: newShareLimit1,
              reserveRatioBP: newReserveRatio1,
              forcedRebalanceThresholdBP: 2500,
              infraFeeBP: 600,
              liquidityFeeBP: 500,
              reservationFeeBP: 200,
            },
            {
              shareLimit: newShareLimit2,
              reserveRatioBP: newReserveRatio2,
              forcedRebalanceThresholdBP: 3500,
              infraFeeBP: 700,
              liquidityFeeBP: 600,
              reservationFeeBP: 300,
            },
          ],
        ),
      )
        .to.emit(operatorGrid, "TierUpdated")
        .withArgs(defaultTierId, newShareLimit1, newReserveRatio1, 2500, 600, 500, 200)
        .to.emit(operatorGrid, "TierUpdated")
        .withArgs(tier1Id, newShareLimit2, newReserveRatio2, 3500, 700, 600, 300);

      // Verify tier 0 (default tier) was updated correctly
      const tier0 = await operatorGrid.tier(defaultTierId);
      expect(tier0.shareLimit).to.equal(newShareLimit1);
      expect(tier0.reserveRatioBP).to.equal(newReserveRatio1);
      expect(tier0.forcedRebalanceThresholdBP).to.equal(2500);
      expect(tier0.infraFeeBP).to.equal(600);
      expect(tier0.liquidityFeeBP).to.equal(500);
      expect(tier0.reservationFeeBP).to.equal(200);

      // Verify tier 1 was updated correctly
      const tier1 = await operatorGrid.tier(tier1Id);
      expect(tier1.shareLimit).to.equal(newShareLimit2);
      expect(tier1.reserveRatioBP).to.equal(newReserveRatio2);
      expect(tier1.forcedRebalanceThresholdBP).to.equal(3500);
      expect(tier1.infraFeeBP).to.equal(700);
      expect(tier1.liquidityFeeBP).to.equal(600);
      expect(tier1.reservationFeeBP).to.equal(300);
    });
  });

  context("changeTier", () => {
    it("reverts on _vault address is zero", async function () {
      await expect(operatorGrid.changeTier(ZeroAddress, 0, 1))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_vault");
    });

    it("changeTier should revert if tier id is not exists", async function () {
      await expect(operatorGrid.connect(stranger).changeTier(vault_NO1_V1, 1, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "TierNotExists",
      );
    });

    it("changeTier should revert if sender is not vault owner or node operator", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit + 1);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, 1)).not.to.be.reverted;
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, 1, 1)).not.to.be.reverted;

      await expect(operatorGrid.connect(stranger).changeTier(vault_NO1_V1, 1, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );
    });

    it("changeTier should revert if tier id is not exists", async function () {
      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 2, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "TierNotExists",
      );
    });

    it("changeTier should not revert if requested twice", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit + 1);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      const vaultOwnerRole = ethers.zeroPadValue(await vaultOwner.getAddress(), 32);
      const confirmTimestamp = await getNextBlockTimestamp();
      const expiryTimestamp = confirmTimestamp + (await operatorGrid.getConfirmExpiry());
      const msgData = operatorGrid.interface.encodeFunctionData("changeTier", [
        await vault_NO1_V1.getAddress(),
        1,
        shareLimit,
      ]);

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit))
        .to.emit(operatorGrid, "RoleMemberConfirmed")
        .withArgs(vaultOwner, vaultOwnerRole, confirmTimestamp, expiryTimestamp, msgData);

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit)).to.not.be.reverted;
    });

    it("changeTier should revert if requested share limit is greater than tier share limit", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit + 1);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await expect(
        operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "RequestedShareLimitTooHigh");
    });

    it("Cannot change tier to the default tier from non-default tier", async function () {
      // First change to non-default tier
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: 1000,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);
      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, 500);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, 500);

      // Now try to change back to default tier - should be forbidden
      const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();
      await expect(
        operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, defaultTierId, 1),
      ).to.be.revertedWithCustomError(operatorGrid, "CannotChangeToDefaultTier");
    });

    it("reverts if tier is not in operator group", async function () {
      await operatorGrid.registerGroup(nodeOperator2, 1000);
      await operatorGrid.registerTiers(nodeOperator2, [
        {
          shareLimit: 1000,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "TierNotInOperatorGroup",
      );
    });

    it("reverts when same tier is requested (no sync via changeTier)", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);
      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit);

      // Now calling changeTier with the same tier should revert with TierAlreadySet
      await expect(
        operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "TierAlreadySet");
    });

    it("do not revert if Tier already requested with different share limit", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);
      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit - 1)).to.not.be.reverted;
    });

    it("reverts if TierLimitExceeded", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1001;
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: _liabilityShares,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await expect(
        operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");
    });

    it("reverts if GroupLimitExceeded", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 999);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1000;
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: _liabilityShares,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await expect(
        operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    });

    it("works if vault shares minted is the same as tier share limit ", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1000;
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });
      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit))
        .to.be.emit(operatorGrid, "TierChanged")
        .withArgs(vault_NO1_V1, 1, shareLimit);
    });

    it("works if vault not in default tier ", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1000;
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: _liabilityShares,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);

      const tier0before = await operatorGrid.tier(0);
      const tier1before = await operatorGrid.tier(1);
      const tier2before = await operatorGrid.tier(2);
      expect(tier0before.liabilityShares).to.equal(_liabilityShares);
      expect(tier1before.liabilityShares).to.equal(0);
      expect(tier2before.liabilityShares).to.equal(0);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit);

      const tier0 = await operatorGrid.tier(0);
      const tier1 = await operatorGrid.tier(1);
      const tier2 = await operatorGrid.tier(2);
      expect(tier0.liabilityShares).to.equal(0);
      expect(tier1.liabilityShares).to.equal(_liabilityShares);
      expect(tier2.liabilityShares).to.equal(0);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 2, shareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 2, shareLimit))
        .to.be.emit(operatorGrid, "TierChanged")
        .withArgs(vault_NO1_V1, 2, shareLimit);

      const tier0after = await operatorGrid.tier(0);
      const tier1after = await operatorGrid.tier(1);
      const tier2after = await operatorGrid.tier(2);
      expect(tier0after.liabilityShares).to.equal(0);
      expect(tier1after.liabilityShares).to.equal(0);
      expect(tier2after.liabilityShares).to.equal(_liabilityShares);
    });

    it("reverts if changeTier has no connection to VaultHub", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await vaultHub.mock__deleteVaultConnection(vault_NO1_V1);

      await expect(
        operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultNotConnected");
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit)).to.not.be.reverted;
    });
  });

  context("mintShares", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const infraFee = 500;
    const liquidityFee = 400;
    const reservationFee = 100;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        infraFeeBP: infraFee,
        liquidityFeeBP: liquidityFee,
        reservationFeeBP: reservationFee,
      },
    ];

    it("mintShares should revert if sender is not `VaultHub`", async function () {
      await expect(
        operatorGrid.connect(stranger).onMintedShares(vault_NO1_V1, 100, false),
      ).to.be.revertedWithCustomError(operatorGrid, "NotAuthorized");
    });

    it("mintShares should revert if group shares limit is exceeded", async function () {
      const shareLimit = 999;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierId = 1;
      await expect(operatorGrid.registerTiers(nodeOperator1, tiers))
        .to.be.emit(operatorGrid, "TierAdded")
        .withArgs(
          nodeOperator1,
          tierId,
          tierShareLimit,
          reserveRatio,
          forcedRebalanceThreshold,
          infraFee,
          liquidityFee,
          reservationFee,
        );

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        infraFeeBP: infraFee,
        liquidityFeeBP: liquidityFee,
        reservationFeeBP: reservationFee,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, tierShareLimit);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    });

    it("mintShares - group=2000 tier=1000 vault1=1000", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierId = 1;
      await expect(operatorGrid.registerTiers(nodeOperator1, tiers))
        .to.be.emit(operatorGrid, "TierAdded")
        .withArgs(
          nodeOperator1,
          tierId,
          tierShareLimit,
          reserveRatio,
          forcedRebalanceThreshold,
          infraFee,
          liquidityFee,
          reservationFee,
        );

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false);

      const group = await operatorGrid.group(nodeOperator1);

      const vaultTier = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      const tier = await operatorGrid.tier(vaultTier.tierId);

      expect(group.liabilityShares).to.equal(tierShareLimit);
      expect(tier.liabilityShares).to.equal(tierShareLimit);
      expect(tier.operator).to.equal(nodeOperator1);
    });

    it("mintShares - Group1 group=2000 tier=1000 NO1_vault1=1000, NO1_vault2=1, reverts TierLimitExceeded", async function () {
      const shareLimit = 2000;
      const tier_NO1_Id1 = 1;

      const tiers2: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V2, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1, false),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");
    });

    it("mintShares - should bypass tier limit check when _bypassLimits=true", async function () {
      const shareLimit = 2000;
      const tier_NO1_Id1 = 1;

      const tiers2: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V2, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, tier_NO1_Id1, tierShareLimit);

      // Fill up the tier limit
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false);

      // Verify tier is at limit
      const tierBefore = await operatorGrid.tier(tier_NO1_Id1);
      expect(tierBefore.liabilityShares).to.equal(tierShareLimit);

      // This should fail without bypass
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1, false),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");

      // But should succeed with _bypassLimits=true
      const exceedingAmount = 50;
      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, exceedingAmount, true)).to.not.be
        .reverted;

      // Verify shares were actually minted beyond the limit
      const tierAfter = await operatorGrid.tier(tier_NO1_Id1);
      expect(tierAfter.liabilityShares).to.equal(tierShareLimit + exceedingAmount);
    });

    it("mintShares - group1=2000, group2=1000, g1Tier1=1000, g2Tier1=1000", async function () {
      const shareLimit = 2000;
      const shareLimit2 = 1000;

      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerGroup(nodeOperator2, shareLimit2);

      const tiers2: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      const tier_NO1_Id1 = 1;
      const tier_NO1_Id2 = 2;

      const tier_NO2_Id1 = 3;
      const tier_NO2_Id2 = 4;

      await operatorGrid.registerTiers(nodeOperator1, tiers2);
      await operatorGrid.registerTiers(nodeOperator2, tiers2);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V2, tier_NO1_Id2, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, tier_NO1_Id2, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO2_V1, tier_NO2_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator2).changeTier(vault_NO2_V1, tier_NO2_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO2_V2, tier_NO2_Id2, tierShareLimit);
      await operatorGrid.connect(nodeOperator2).changeTier(vault_NO2_V2, tier_NO2_Id2, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V2, tierShareLimit, false);

      const group = await operatorGrid.group(nodeOperator1);
      const group2 = await operatorGrid.group(nodeOperator2);

      const vaultTier = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      const vaultTier2 = await operatorGrid.vaultTierInfo(vault_NO2_V2);

      const tier = await operatorGrid.tier(vaultTier.tierId);
      const tier2 = await operatorGrid.tier(vaultTier2.tierId);

      expect(group.liabilityShares).to.equal(tierShareLimit);
      expect(group2.liabilityShares).to.equal(tierShareLimit);
      expect(tier.liabilityShares).to.equal(tierShareLimit);
      expect(tier2.liabilityShares).to.equal(tierShareLimit);
    });

    it("changeTier - group=2000, tier=1000, vault1=500", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      const vaultShareLimit = tierShareLimit / 2;

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, vaultShareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, vaultShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(vault_NO1_V1, vaultShareLimit, 2000, 1800, 500, 400, 100);
    });
  });

  context("Bypass Limits (_bypassLimits flag)", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const infraFee = 500;
    const liquidityFee = 400;
    const reservationFee = 100;

    beforeEach(async () => {
      await operatorGrid.registerGroup(nodeOperator1, 2000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ]);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, tierShareLimit);
    });

    it("should bypass jail restriction when _bypassLimits=true", async () => {
      const vaultAddress = vault_NO1_V1.target;
      const mintAmount = 100;

      // Put vault in jail
      await operatorGrid.setVaultJailStatus(vaultAddress, true);
      expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

      // Normal minting should fail
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, false),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

      // But bypass should work
      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, true)).to.not.be
        .reverted;

      // Verify shares were minted
      const tier = await operatorGrid.tier(1);
      expect(tier.liabilityShares).to.equal(mintAmount);
    });

    it("should bypass tier limit when _bypassLimits=true", async () => {
      const vaultAddress = vault_NO1_V1.target;

      // Fill tier to capacity
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, tierShareLimit, false);

      // Verify tier is at limit
      const tierBefore = await operatorGrid.tier(1);
      expect(tierBefore.liabilityShares).to.equal(tierShareLimit);

      const exceedingAmount = 200;

      // Normal minting should fail when exceeding tier limit
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, exceedingAmount, false),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");

      // But bypass should work
      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, exceedingAmount, true)).to.not.be
        .reverted;

      // Verify shares were minted beyond the limit
      const tierAfter = await operatorGrid.tier(1);
      expect(tierAfter.liabilityShares).to.equal(tierShareLimit + exceedingAmount);
    });

    it("onMintedShares with _bypassLimits=true bypasses both jail and tier limit", async () => {
      const vaultAddress = vault_NO1_V1.target;

      // Put vault in jail
      await operatorGrid.setVaultJailStatus(vaultAddress, true);
      expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

      // Fill tier to capacity first (using bypass since vault is in jail)
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, tierShareLimit, true);

      // Verify tier is at limit
      const tierBefore = await operatorGrid.tier(1);
      expect(tierBefore.liabilityShares).to.equal(tierShareLimit);

      // Now simulate socializeBadDebt by calling onMintedShares with bypass
      // This should exceed tier limits but still update counters
      const exceedingAmount = 300;
      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, exceedingAmount, true)).to.not.be
        .reverted;

      // Verify tier counters are still updated correctly despite bypass
      const tierAfter = await operatorGrid.tier(1);
      expect(tierAfter.liabilityShares).to.equal(tierShareLimit + exceedingAmount);

      // Verify group counters are also updated
      const groupAfter = await operatorGrid.group(nodeOperator1);
      expect(groupAfter.liabilityShares).to.equal(tierShareLimit + exceedingAmount);

      // Verify vault is still in jail
      expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

      // Verify normal minting would still fail due to jail (even if tier had capacity)
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, 1, false),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");
    });
  });

  context("Vault Jail Status", () => {
    describe("setVaultJailStatus", () => {
      it("should set vault jail status to true/false", async () => {
        const vaultAddress = vault_NO1_V1.target;

        // First set to jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

        // Then remove from jail
        await expect(operatorGrid.setVaultJailStatus(vaultAddress, false))
          .to.emit(operatorGrid, "VaultJailStatusUpdated")
          .withArgs(vaultAddress, false);

        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.false;
      });

      it("should revert if caller does not have REGISTRY_ROLE", async () => {
        const vaultAddress = vault_NO1_V1.target;

        await expect(
          operatorGrid.connect(stranger).setVaultJailStatus(vaultAddress, true),
        ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
      });

      it("should revert if vault address is zero", async () => {
        await expect(operatorGrid.setVaultJailStatus(ZeroAddress, true))
          .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
          .withArgs("_vault");
      });

      it("should revert if trying to set the same jail status", async () => {
        const vaultAddress = vault_NO1_V1.target;

        // Initially false, trying to set false again
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.false;
        await expect(operatorGrid.setVaultJailStatus(vaultAddress, false)).to.be.revertedWithCustomError(
          operatorGrid,
          "VaultInJailAlreadySet",
        );

        // Set to true first
        await operatorGrid.setVaultJailStatus(vaultAddress, true);

        // Try to set true again
        await expect(operatorGrid.setVaultJailStatus(vaultAddress, true)).to.be.revertedWithCustomError(
          operatorGrid,
          "VaultInJailAlreadySet",
        );
      });

      it("should allow admin with REGISTRY_ROLE to set jail status", async () => {
        const vaultAddress = vault_NO1_V1.target;

        // Grant REGISTRY_ROLE to nodeOperator1
        await operatorGrid.grantRole(await operatorGrid.REGISTRY_ROLE(), nodeOperator1);

        await expect(operatorGrid.connect(nodeOperator1).setVaultJailStatus(vaultAddress, true))
          .to.emit(operatorGrid, "VaultJailStatusUpdated")
          .withArgs(vaultAddress, true);

        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;
      });
    });

    describe("onMintedShares jail check", () => {
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const forcedRebalanceThreshold = 1800;
      const infraFee = 500;
      const liquidityFee = 400;
      const reservationFee = 100;
      const tiers: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      beforeEach(async () => {
        // Set up a group and tier for testing
        const shareLimit = 2000;
        await operatorGrid.registerGroup(nodeOperator1, shareLimit);
        await operatorGrid.registerTiers(nodeOperator1, tiers);

        await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
          owner: vaultOwner,
          vaultIndex: 1,
          disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
          beaconChainDepositsPauseIntent: false,
        });

        const tierId = 1;
        await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, tierShareLimit);
        await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, tierShareLimit);
      });

      it("should revert onMintedShares if vault is in jail", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const mintAmount = 100;

        // Put vault in jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

        // Try to mint shares - should revert
        await expect(
          operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, false),
        ).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");
      });

      it("should allow onMintedShares if vault is not in jail", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const mintAmount = 100;

        // Ensure vault is not in jail
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.false;

        // Mint shares - should succeed
        await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, false)).to.not.be
          .reverted;

        // Verify shares were minted
        const tier = await operatorGrid.tier(1);
        expect(tier.liabilityShares).to.equal(mintAmount);
      });

      it("should allow onMintedShares after vault is removed from jail", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const mintAmount = 100;

        // Put vault in jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);

        // Verify minting fails while in jail
        await expect(
          operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, false),
        ).to.be.revertedWithCustomError(operatorGrid, "VaultInJail");

        // Remove from jail
        await operatorGrid.setVaultJailStatus(vaultAddress, false);
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.false;

        // Now minting should succeed
        await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, false)).to.not.be
          .reverted;

        // Verify shares were minted
        const tier = await operatorGrid.tier(1);
        expect(tier.liabilityShares).to.equal(mintAmount);
      });

      it("should allow onMintedShares with _bypassLimits=true even when vault is in jail", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const mintAmount = 100;

        // Put vault in jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

        // Minting with _bypassLimits=true should succeed even when in jail
        await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, true)).to.not.be
          .reverted;

        // Verify shares were minted
        const tier = await operatorGrid.tier(1);
        expect(tier.liabilityShares).to.equal(mintAmount);
      });
    });

    describe("isVaultInJail", () => {
      it("should return false for vault not in jail", async () => {
        const vaultAddress = vault_NO1_V1.target;

        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.false;
      });

      it("should return true for vault in jail", async () => {
        const vaultAddress = vault_NO1_V1.target;

        await operatorGrid.setVaultJailStatus(vaultAddress, true);

        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;
      });

      it("should return false for non-existent vault", async () => {
        const nonExistentVault = certainAddress("nonExistentVault");

        expect(await operatorGrid.isVaultInJail(nonExistentVault)).to.be.false;
      });
    });

    describe("Integration with other operations", () => {
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const forcedRebalanceThreshold = 1800;
      const infraFee = 500;
      const liquidityFee = 400;
      const reservationFee = 100;
      const tiers: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      beforeEach(async () => {
        // Set up a group and tier for testing
        const shareLimit = 2000;
        await operatorGrid.registerGroup(nodeOperator1, shareLimit);
        await operatorGrid.registerTiers(nodeOperator1, tiers);

        await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
          owner: vaultOwner,
          vaultIndex: 1,
          disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
          beaconChainDepositsPauseIntent: false,
        });
      });

      it("should allow tier changes for jailed vaults", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const tierId = 1;

        // Put vault in jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);

        // Tier changes should still be allowed
        await operatorGrid.connect(vaultOwner).changeTier(vaultAddress, tierId, tierShareLimit);
        await expect(operatorGrid.connect(nodeOperator1).changeTier(vaultAddress, tierId, tierShareLimit))
          .to.emit(operatorGrid, "TierChanged")
          .withArgs(vaultAddress, tierId, tierShareLimit);
      });

      it("should preserve jail status across tier resets", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const tierId = 1;

        // Set tier first
        await operatorGrid.connect(vaultOwner).changeTier(vaultAddress, tierId, tierShareLimit);
        await operatorGrid.connect(nodeOperator1).changeTier(vaultAddress, tierId, tierShareLimit);

        // Put vault in jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;

        // Reset tier (simulating VaultHub calling resetVaultTier)
        await operatorGrid.connect(vaultHubAsSigner).resetVaultTier(vaultAddress);

        // Jail status should be preserved
        expect(await operatorGrid.isVaultInJail(vaultAddress)).to.be.true;
      });

      it("should allow onBurnedShares for jailed vaults", async () => {
        const vaultAddress = vault_NO1_V1.target;
        const tierId = 1;
        const mintAmount = 100;
        const burnAmount = 50;

        // Set tier and mint some shares first
        await operatorGrid.connect(vaultOwner).changeTier(vaultAddress, tierId, tierShareLimit);
        await operatorGrid.connect(nodeOperator1).changeTier(vaultAddress, tierId, tierShareLimit);
        await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vaultAddress, mintAmount, false);

        // Put vault in jail
        await operatorGrid.setVaultJailStatus(vaultAddress, true);

        // Burning should still be allowed even when jailed
        await expect(operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vaultAddress, burnAmount)).to.not.be
          .reverted;

        // Verify shares were burned
        const tier = await operatorGrid.tier(tierId);
        expect(tier.liabilityShares).to.equal(mintAmount - burnAmount);
      });
    });
  });

  context("burnShares", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const infraFee = 500;
    const liquidityFee = 400;
    const reservationFee = 100;

    it("burnShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).onBurnedShares(vault_NO1_V1, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("burnShares works, minted=limit+1, burned=limit", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tiers2: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      const tier_NO1_Id1 = 1;
      const tier_NO1_Id2 = 2;

      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V2, tier_NO1_Id2, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, tier_NO1_Id2, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1, false);

      await operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);

      const vaultTier = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      const vaultTier2 = await operatorGrid.vaultTierInfo(vault_NO1_V2);

      const tier = await operatorGrid.tier(vaultTier.tierId);
      const tier2 = await operatorGrid.tier(vaultTier2.tierId);

      expect(group.liabilityShares).to.equal(1);
      expect(tier.liabilityShares).to.equal(0);
      expect(tier2.liabilityShares).to.equal(1);
    });

    it("burnShares works on DEFAULT_TIER, minted=limit+1, burned=limit", async function () {
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit, false);
      await operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, tierShareLimit - 1);

      const tier = await operatorGrid.tier(await operatorGrid.DEFAULT_TIER_ID());
      expect(tier.liabilityShares).to.equal(1);
    });
  });

  context("vaultInfo", async function () {
    it("should return correct vault limits", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const forcedRebalanceThreshold = 1800;
      const infraFee = 500;
      const liquidityFee = 400;
      const reservationFee = 100;

      const tiers: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          infraFeeBP: infraFee,
          liquidityFeeBP: liquidityFee,
          reservationFeeBP: reservationFee,
        },
      ];

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        owner: vaultOwner,
        shareLimit: shareLimit,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        beaconChainDepositsPauseIntent: false,
      });

      const tier_NO1_Id1 = 1;

      await operatorGrid.registerTiers(nodeOperator1, tiers);
      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      const [
        retGroupOperator,
        retTierIndex,
        retShareLimit,
        retReserveRatio,
        retForcedRebalanceThreshold,
        retInfraFee,
        retLiquidityFee,
        retReservationFee,
      ] = await operatorGrid.vaultTierInfo(vault_NO1_V1);

      expect(retGroupOperator).to.equal(nodeOperator1);
      expect(retTierIndex).to.equal(tier_NO1_Id1);
      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retForcedRebalanceThreshold).to.equal(forcedRebalanceThreshold);
      expect(retInfraFee).to.equal(infraFee);
      expect(retLiquidityFee).to.equal(liquidityFee);
      expect(retReservationFee).to.equal(reservationFee);
    });
  });

  context("resetVaultTier", () => {
    it("reverts if called by non-VaultHub", async () => {
      await expect(operatorGrid.connect(stranger).resetVaultTier(vault_NO1_V1))
        .to.be.revertedWithCustomError(operatorGrid, "NotAuthorized")
        .withArgs("resetVaultTier", stranger);
    });

    it("does nothing if vault is already in default tier", async () => {
      const vaultTierBefore = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      expect(vaultTierBefore.tierId).to.equal(await operatorGrid.DEFAULT_TIER_ID());

      await operatorGrid.connect(vaultHubAsSigner).resetVaultTier(vault_NO1_V1);

      const vaultTierAfter = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      expect(vaultTierAfter.tierId).to.equal(await operatorGrid.DEFAULT_TIER_ID());
    });

    it("resets vault's tier to default", async () => {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit);

      const vaultTierBefore = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      expect(vaultTierBefore.tierId).to.equal(1);

      // Reset tier
      await operatorGrid.connect(vaultHubAsSigner).resetVaultTier(vault_NO1_V1);

      // Check final state
      const vaultTierAfter = await operatorGrid.vaultTierInfo(vault_NO1_V1);
      expect(vaultTierAfter.tierId).to.equal(await operatorGrid.DEFAULT_TIER_ID());
    });
  });

  context("effectiveShareLimit", () => {
    it("returns 0 if vault is not connected to VaultHub", async () => {
      const unknownVault = certainAddress("unknown");
      const effectiveShareLimit = await operatorGrid.effectiveShareLimit(unknownVault);
      expect(effectiveShareLimit).to.equal(0);
    });

    it("limits by vault share limit", async () => {
      const shareLimit = 999n;
      const _liabilityShares = 123;

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: _liabilityShares,
      });
      await vaultHub.mock__setVaultRecord(vault_NO1_V2, {
        ...record,
        liabilityShares: _liabilityShares + 1,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, _liabilityShares + 1, false);

      const tier = await operatorGrid.tier(await operatorGrid.DEFAULT_TIER_ID());
      const vault1LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V1);
      const vault2LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V2);

      const vault1 = await vaultHub.vaultConnection(vault_NO1_V1);
      const vault1ShareLimit = vault1.shareLimit;

      expect(tier.liabilityShares).to.equal(vault1LiabilityShares + vault2LiabilityShares);

      const effectiveShareLimit = await operatorGrid.effectiveShareLimit(vault_NO1_V1);
      expect(effectiveShareLimit).to.equal(vault1ShareLimit);
    });

    it("limits by tier share limit", async () => {
      const shareLimit = ether("1001");
      const _liabilityShares = 123;

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: _liabilityShares,
      });
      await vaultHub.mock__setVaultRecord(vault_NO1_V2, {
        ...record,
        liabilityShares: _liabilityShares + 1,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, _liabilityShares + 1, false);

      const tier = await operatorGrid.tier(await operatorGrid.DEFAULT_TIER_ID());
      const vault1LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V1);
      const vault2LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V2);

      expect(tier.liabilityShares).to.equal(vault1LiabilityShares + vault2LiabilityShares);

      const effectiveShareLimit = await operatorGrid.effectiveShareLimit(vault_NO1_V1);
      expect(effectiveShareLimit).to.equal(tier.shareLimit - tier.liabilityShares + vault1LiabilityShares);
    });

    it("limits by tier capacity == 0", async () => {
      const shareLimit = ether("1001");
      const _liabilityShares = ether("500");

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: _liabilityShares,
      });
      await vaultHub.mock__setVaultRecord(vault_NO1_V2, {
        ...record,
        liabilityShares: _liabilityShares,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares, false);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, _liabilityShares, false);

      const tier = await operatorGrid.tier(await operatorGrid.DEFAULT_TIER_ID());
      const vault1LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V1);
      const vault2LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V2);

      expect(tier.liabilityShares).to.equal(vault1LiabilityShares + vault2LiabilityShares);

      const effectiveShareLimit = await operatorGrid.effectiveShareLimit(vault_NO1_V1);
      expect(effectiveShareLimit).to.equal(vault1LiabilityShares); //tier.shareLimit-tier.liabilityShares==0
    });

    it("limits by tier NOT in Default group", async () => {
      const shareLimit = ether("1001");
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      const tierId = 1;

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, shareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, shareLimit))
        .to.be.emit(operatorGrid, "TierChanged")
        .withArgs(vault_NO1_V1, tierId, shareLimit);

      const liabilityShares = ether("500");
      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: liabilityShares,
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, liabilityShares, false);

      const tier = await operatorGrid.tier(1);
      const vault1LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V1);

      const groupRemaining = shareLimit - liabilityShares;

      expect(tier.liabilityShares).to.equal(vault1LiabilityShares);

      const effectiveShareLimit = await operatorGrid.effectiveShareLimit(vault_NO1_V1);
      expect(effectiveShareLimit).to.equal(groupRemaining + vault1LiabilityShares);
    });

    it("limits by tier NOT in Default group, decrease group share limit", async () => {
      const shareLimit = ether("1001");
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          infraFeeBP: 500,
          liquidityFeeBP: 400,
          reservationFeeBP: 100,
        },
      ]);

      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        infraFeeBP: 500,
        liquidityFeeBP: 400,
        reservationFeeBP: 100,
        owner: vaultOwner,
        vaultIndex: 1,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
        beaconChainDepositsPauseIntent: false,
      });

      const tierId = 1;

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, shareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, shareLimit))
        .to.be.emit(operatorGrid, "TierChanged")
        .withArgs(vault_NO1_V1, tierId, shareLimit);

      await vaultHub.mock__setVaultRecord(vault_NO1_V1, {
        ...record,
        liabilityShares: ether("500"),
      });

      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, ether("500"), false);

      //decrease group share limit
      await operatorGrid.updateGroupShareLimit(nodeOperator1, 1n);

      const tier = await operatorGrid.tier(1);
      const vault1LiabilityShares = await vaultHub.liabilityShares(vault_NO1_V1);

      expect(tier.liabilityShares).to.equal(vault1LiabilityShares);

      const effectiveShareLimit = await operatorGrid.effectiveShareLimit(vault_NO1_V1);
      expect(effectiveShareLimit).to.equal(vault1LiabilityShares);
    });
  });

  context("syncTier", () => {
    let tier1Id: number;

    const createVaultConnection = (
      owner: string,
      shareLimit: bigint,
      vaultIndex: bigint = 1n,
      reserveRatioBP: number = RESERVE_RATIO,
      forcedRebalanceThresholdBP: number = FORCED_REBALANCE_THRESHOLD,
      infraFeeBP: number = INFRA_FEE,
      liquidityFeeBP: number = LIQUIDITY_FEE,
      reservationFeeBP: number = RESERVATION_FEE,
    ) => ({
      owner,
      shareLimit,
      vaultIndex,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      reserveRatioBP,
      forcedRebalanceThresholdBP,
      infraFeeBP,
      liquidityFeeBP,
      reservationFeeBP,
      beaconChainDepositsPauseIntent: false,
    });

    beforeEach(async () => {
      // Register group and tier
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit + 1);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 3000, // Different from default
          forcedRebalanceThresholdBP: 2500, // Different from default
          infraFeeBP: 600, // Different from default
          liquidityFeeBP: 500, // Different from default
          reservationFeeBP: 200, // Different from default
        },
      ]);
      tier1Id = 1;
    });

    it("reverts when vault address is zero", async () => {
      await expect(operatorGrid.syncTier(ZeroAddress))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts when caller is not authorized for confirmation", async () => {
      // Set up connected vault
      const connection = createVaultConnection(vaultOwner.address, 500n);
      connection.infraFeeBP = 123;
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);

      await expect(operatorGrid.connect(stranger).syncTier(vault_NO1_V1)).to.be.revertedWithCustomError(
        operatorGrid,
        "SenderNotMember",
      );
    });

    it("syncs vault with default tier parameters via syncTier", async () => {
      // Set up connected vault with default tier (tier 0)
      const originalShareLimit = 500n;
      const connection = createVaultConnection(
        vaultOwner.address,
        originalShareLimit,
        1n,
        1500, // Different from tier
        1200, // Different from tier
        300, // Different from tier
        200, // Different from tier
        50, // Different from tier
      );
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);

      // Need both vault owner and node operator confirmations for sync
      await operatorGrid.connect(vaultOwner).syncTier(vault_NO1_V1);

      // Verify updateConnection was called with tier parameters but original share limit
      const expectedParams = await operatorGrid.tier(0); // Default tier
      // Check that VaultHub.updateConnection was called correctly
      await expect(operatorGrid.connect(nodeOperator1).syncTier(vault_NO1_V1))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          vault_NO1_V1.target,
          originalShareLimit,
          expectedParams.reserveRatioBP,
          expectedParams.forcedRebalanceThresholdBP,
          expectedParams.infraFeeBP,
          expectedParams.liquidityFeeBP,
          expectedParams.reservationFeeBP,
        );
    });

    it("syncs vault with non-default tier parameters via syncTier", async () => {
      // Change vault to tier 1
      const connection = createVaultConnection(vaultOwner.address, 500n);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);
      // Use record with 0 liability shares for clean test
      const cleanRecord = { ...record, liabilityShares: 0n };
      await vaultHub.mock__setVaultRecord(vault_NO1_V1, cleanRecord);

      // First change to tier 1
      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier1Id, 400);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier1Id, 400);

      // Now sync with tier (connection should have different params than tier)
      const modifiedConnection = createVaultConnection(
        vaultOwner.address,
        400n,
        1n,
        1500, // Different from tier
        1200, // Different from tier
        300, // Different from tier
        200, // Different from tier
        50, // Different from tier
      );
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, modifiedConnection);

      // Sync via syncTier with both confirmations
      await operatorGrid.connect(vaultOwner).syncTier(vault_NO1_V1);

      // Verify updateConnection was called with tier parameters
      const expectedParams = await operatorGrid.tier(tier1Id);
      await expect(operatorGrid.connect(nodeOperator1).syncTier(vault_NO1_V1))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          vault_NO1_V1.target,
          400n, // Original share limit preserved
          expectedParams.reserveRatioBP,
          expectedParams.forcedRebalanceThresholdBP,
          expectedParams.infraFeeBP,
          expectedParams.liquidityFeeBP,
          expectedParams.reservationFeeBP,
        );
    });

    it("preserves the original share limit when syncing via syncTier", async () => {
      // Set up connected vault
      const originalShareLimit = 750n;
      const connection = createVaultConnection(vaultOwner.address, originalShareLimit);
      connection.infraFeeBP = 123;
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);

      // Sync via syncTier with both confirmations
      await operatorGrid.connect(vaultOwner).syncTier(vault_NO1_V1);

      // Verify the share limit is preserved
      await expect(operatorGrid.connect(nodeOperator1).syncTier(vault_NO1_V1))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          vault_NO1_V1.target,
          originalShareLimit, // Should preserve original share limit
          RESERVE_RATIO, // Default tier params
          FORCED_REBALANCE_THRESHOLD,
          INFRA_FEE, // Should update infra fee
          LIQUIDITY_FEE, // Should update liquidity fee
          RESERVATION_FEE, // Should update reservation fee
        );
    });

    it("reverts with VaultAlreadySyncedWithTier when already in sync", async () => {
      // Default tier (0) and connection initially in sync as per before() setup
      await expect(operatorGrid.connect(vaultOwner).syncTier(vault_NO1_V1)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultAlreadySyncedWithTier",
      );
    });
  });

  context("updateVaultShareLimit", () => {
    let tier1Id: number;

    const createVaultConnection = (
      owner: string,
      shareLimit: bigint,
      vaultIndex: bigint = 1n,
      reserveRatioBP: number = RESERVE_RATIO,
      forcedRebalanceThresholdBP: number = FORCED_REBALANCE_THRESHOLD,
      infraFeeBP: number = INFRA_FEE,
      liquidityFeeBP: number = LIQUIDITY_FEE,
      reservationFeeBP: number = RESERVATION_FEE,
    ) => ({
      owner,
      shareLimit,
      vaultIndex,
      disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      reserveRatioBP,
      forcedRebalanceThresholdBP,
      infraFeeBP,
      liquidityFeeBP,
      reservationFeeBP,
      beaconChainDepositsPauseIntent: false,
    });

    beforeEach(async () => {
      // Register group and tier
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit + 1);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 3000,
          forcedRebalanceThresholdBP: 2500,
          infraFeeBP: 600,
          liquidityFeeBP: 500,
          reservationFeeBP: 200,
        },
      ]);
      tier1Id = 1;
    });

    it("reverts when vault address is zero", async () => {
      await expect(operatorGrid.updateVaultShareLimit(ZeroAddress, 100))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts when vault is not connected to VaultHub", async () => {
      // Vault is not connected (vaultIndex = 0)
      const connection = createVaultConnection(vaultOwner.address, 500n, 0n);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);

      await expect(
        operatorGrid.connect(vaultOwner).updateVaultShareLimit(vault_NO1_V1, 100),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultNotConnected");
    });

    it("reverts when requested share limit exceeds tier share limit", async () => {
      // Set up connected vault
      const connection = createVaultConnection(vaultOwner.address, 500n);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);

      const tierShareLimit = (await operatorGrid.tier(0)).shareLimit; // Default tier
      const excessiveLimit = tierShareLimit + 1n;

      await expect(operatorGrid.connect(vaultOwner).updateVaultShareLimit(vault_NO1_V1, excessiveLimit))
        .to.be.revertedWithCustomError(operatorGrid, "RequestedShareLimitTooHigh")
        .withArgs(excessiveLimit, tierShareLimit);
    });

    it("reverts when requested share limit equals current share limit", async () => {
      const currentShareLimit = 500n;
      const connection = createVaultConnection(vaultOwner.address, currentShareLimit);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);

      await expect(
        operatorGrid.connect(vaultOwner).updateVaultShareLimit(vault_NO1_V1, currentShareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "ShareLimitAlreadySet");
    });

    it("requires confirmation from both vault owner and node operator for increasing share limit", async () => {
      // First, move vault to tier 1
      const connection = createVaultConnection(vaultOwner.address, 500n);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);
      const cleanRecord = { ...record, liabilityShares: 0n };
      await vaultHub.mock__setVaultRecord(vault_NO1_V1, cleanRecord);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier1Id, 400);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier1Id, 400);

      // Now try to increase share limit
      const currentShareLimit = 400n;
      const newShareLimit = 600n;
      const updatedConnection = createVaultConnection(vaultOwner.address, currentShareLimit);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, updatedConnection);

      // First confirmation from vault owner - should return false (not confirmed yet)
      expect(
        await operatorGrid.connect(vaultOwner).updateVaultShareLimit.staticCall(vault_NO1_V1, newShareLimit),
      ).to.equal(false);

      await operatorGrid.connect(vaultOwner).updateVaultShareLimit(vault_NO1_V1, newShareLimit);

      // Second confirmation from node operator - should return true (fully confirmed)
      expect(
        await operatorGrid.connect(nodeOperator1).updateVaultShareLimit.staticCall(vault_NO1_V1, newShareLimit),
      ).to.equal(true);

      await expect(operatorGrid.connect(nodeOperator1).updateVaultShareLimit(vault_NO1_V1, newShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );
    });

    it("requires confirmation from both vault owner and node operator for decreasing share limit", async () => {
      // First, move vault to tier 1
      const connection = createVaultConnection(vaultOwner.address, 500n);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);
      const cleanRecord = { ...record, liabilityShares: 0n };
      await vaultHub.mock__setVaultRecord(vault_NO1_V1, cleanRecord);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier1Id, 600);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier1Id, 600);

      // Now try to decrease share limit
      const currentShareLimit = 600n;
      const newShareLimit = 400n;
      const updatedConnection = createVaultConnection(vaultOwner.address, currentShareLimit);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, updatedConnection);

      // First confirmation from vault owner - should return false (not confirmed yet)
      expect(
        await operatorGrid.connect(vaultOwner).updateVaultShareLimit.staticCall(vault_NO1_V1, newShareLimit),
      ).to.equal(false);

      await operatorGrid.connect(vaultOwner).updateVaultShareLimit(vault_NO1_V1, newShareLimit);

      // Second confirmation from node operator - should return true (fully confirmed)
      expect(
        await operatorGrid.connect(nodeOperator1).updateVaultShareLimit.staticCall(vault_NO1_V1, newShareLimit),
      ).to.equal(true);

      await expect(operatorGrid.connect(nodeOperator1).updateVaultShareLimit(vault_NO1_V1, newShareLimit)).to.emit(
        vaultHub,
        "VaultConnectionUpdated",
      );
    });

    it("preserves connection parameters other than share limit", async () => {
      const currentShareLimit = 300n;
      const newShareLimit = 500n;
      const originalConnection = createVaultConnection(
        vaultOwner.address,
        currentShareLimit,
        1n,
        1234, // Custom reserve ratio
        1111, // Custom forced rebalance threshold
        777, // Custom infra fee
        888, // Custom liquidity fee
        999, // Custom reservation fee
      );
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, originalConnection);

      await operatorGrid.connect(vaultOwner).updateVaultShareLimit(vault_NO1_V1, newShareLimit);

      // Verify that other parameters are preserved
      await expect(operatorGrid.connect(nodeOperator1).updateVaultShareLimit(vault_NO1_V1, newShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          vault_NO1_V1.target,
          newShareLimit,
          1234, // Should preserve original reserve ratio
          1111, // Should preserve original forced rebalance threshold
          777, // Should preserve original infra fee
          888, // Should preserve original liquidity fee
          999, // Should preserve original reservation fee
        );
    });

    it("reverts when stranger tries to confirm in non-default tier", async () => {
      // First, move vault to tier 1
      const connection = createVaultConnection(vaultOwner.address, 500n);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, connection);
      const cleanRecord = { ...record, liabilityShares: 0n };
      await vaultHub.mock__setVaultRecord(vault_NO1_V1, cleanRecord);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier1Id, 400);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier1Id, 400);

      // Now try to increase share limit
      const currentShareLimit = 400n;
      const newShareLimit = 600n;
      const updatedConnection = createVaultConnection(vaultOwner.address, currentShareLimit);
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, updatedConnection);

      await expect(
        operatorGrid.connect(stranger).updateVaultShareLimit(vault_NO1_V1, newShareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "SenderNotMember");
    });
  });

  context("updateVaultFees", () => {
    let vault: StakingVault__MockForOperatorGrid;

    before(async () => {
      // Set up a connected vault for fee update tests
      await vaultHub.mock__setVaultConnection(vault_NO1_V1, {
        shareLimit: DEFAULT_TIER_SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO,
        forcedRebalanceThresholdBP: FORCED_REBALANCE_THRESHOLD,
        infraFeeBP: INFRA_FEE,
        liquidityFeeBP: LIQUIDITY_FEE,
        reservationFeeBP: RESERVATION_FEE,
        owner: vaultOwner,
        vaultIndex: 1,
        beaconChainDepositsPauseIntent: false,
        disconnectInitiatedTs: DISCONNECT_NOT_INITIATED,
      });
      vault = vault_NO1_V1;
    });

    it("reverts if called by non-REGISTRY_ROLE", async () => {
      await expect(
        operatorGrid.connect(stranger).updateVaultFees(vault, INFRA_FEE, LIQUIDITY_FEE, RESERVATION_FEE),
      ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
    });

    it("reverts if vault address is zero", async () => {
      await expect(operatorGrid.updateVaultFees(ZeroAddress, INFRA_FEE, LIQUIDITY_FEE, RESERVATION_FEE))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts if infra fee is too high", async () => {
      const tooHighInfraFeeBP = MAX_FEE_BP + 1n;

      await expect(operatorGrid.updateVaultFees(vault, tooHighInfraFeeBP, LIQUIDITY_FEE, RESERVATION_FEE))
        .to.be.revertedWithCustomError(operatorGrid, "InvalidBasisPoints")
        .withArgs(tooHighInfraFeeBP, MAX_FEE_BP);
    });

    it("reverts if liquidity fee is too high", async () => {
      const tooHighLiquidityFeeBP = MAX_FEE_BP + 1n;

      await expect(operatorGrid.updateVaultFees(vault, INFRA_FEE, tooHighLiquidityFeeBP, RESERVATION_FEE))
        .to.be.revertedWithCustomError(operatorGrid, "InvalidBasisPoints")
        .withArgs(tooHighLiquidityFeeBP, MAX_FEE_BP);
    });

    it("reverts if reservation fee is too high", async () => {
      const tooHighReservationFeeBP = MAX_FEE_BP + 1n;

      await expect(operatorGrid.updateVaultFees(vault, INFRA_FEE, LIQUIDITY_FEE, tooHighReservationFeeBP))
        .to.be.revertedWithCustomError(operatorGrid, "InvalidBasisPoints")
        .withArgs(tooHighReservationFeeBP, MAX_FEE_BP);
    });

    it("updates the vault fees", async () => {
      const newInfraFeeBP = INFRA_FEE * 2;
      const newLiquidityFeeBP = LIQUIDITY_FEE * 2;
      const newReservationFeeBP = RESERVATION_FEE * 2;

      // Mock a report timestamp to ensure fresh report for updateConnection requirement
      await vaultHub.mock__setVaultRecord(vault, {
        ...record,
        report: {
          ...record.report,
          timestamp: await getNextBlockTimestamp(),
        },
      });

      const connectionBefore = await vaultHub.vaultConnection(vault);
      await expect(operatorGrid.updateVaultFees(vault, newInfraFeeBP, newLiquidityFeeBP, newReservationFeeBP))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(
          vault,
          connectionBefore.shareLimit,
          connectionBefore.reserveRatioBP,
          connectionBefore.forcedRebalanceThresholdBP,
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
});
