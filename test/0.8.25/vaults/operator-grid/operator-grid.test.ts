import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  PredepositGuarantee_HarnessForFactory,
  StakingVault__MockForOperatorGrid,
  StETH__MockForOperatorGrid,
  VaultHub__MockForOperatorGrid,
  WstETH__HarnessForVault,
} from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";

import { certainAddress, ether, GENESIS_FORK_VERSION, impersonate } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const DEFAULT_TIER_SHARE_LIMIT = ether("1000");
const RESERVE_RATIO = 2000;
const FORCED_REBALANCE_THRESHOLD = 1800;
const TREASURY_FEE = 500;

describe("OperatorGrid.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let vaultHubAsSigner: HardhatEthersSigner;

  let nodeOperator1: HardhatEthersSigner;
  let nodeOperator2: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let steth: StETH__MockForOperatorGrid;
  let wsteth: WstETH__HarnessForVault;
  let vaultHub: VaultHub__MockForOperatorGrid;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;
  let vault_NO1_V1: StakingVault__MockForOperatorGrid;
  let vault_NO1_V2: StakingVault__MockForOperatorGrid;
  let vault_NO2_V1: StakingVault__MockForOperatorGrid;
  let vault_NO2_V2: StakingVault__MockForOperatorGrid;

  let originalState: string;

  before(async () => {
    [deployer, vaultOwner, stranger, nodeOperator1, nodeOperator2] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForOperatorGrid");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
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
      treasuryFeeBP: TREASURY_FEE,
    };
    await operatorGrid.initialize(deployer, defaultTierParams);
    await operatorGrid.grantRole(await operatorGrid.REGISTRY_ROLE(), deployer);

    // VaultHub
    vaultHub = await ethers.deployContract("VaultHub__MockForOperatorGrid", []);

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
        treasuryFeeBP: TREASURY_FEE,
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
        treasuryFeeBP: TREASURY_FEE,
      };
      await expect(operatorGridLocal.initialize(ZeroAddress, defaultTierParams))
        .to.be.revertedWithCustomError(operatorGridImpl, "ZeroArgument")
        .withArgs("_admin");
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
    const treasuryFee = 500;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        treasuryFeeBP: treasuryFee,
      },
    ];

    it("reverts if tier id is not exists with custom error", async function () {
      const tierCount = await operatorGrid.tierCount();
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

    it("reverts if not authorized", async function () {
      await expect(operatorGrid.connect(stranger).alterTier(0, tiers[0])).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("works", async function () {
      await expect(operatorGrid.alterTier(0, tiers[0]))
        .to.emit(operatorGrid, "TierUpdated")
        .withArgs(0, tierShareLimit, reserveRatio, forcedRebalanceThreshold, treasuryFee);
    });

    it("tierCount - works", async function () {
      //default tier
      expect(await operatorGrid.tierCount()).to.equal(1);

      await operatorGrid.registerGroup(groupOperator, 1000);
      await operatorGrid.registerTiers(groupOperator, tiers);

      expect(await operatorGrid.tierCount()).to.equal(2);
    });
  });

  context("Validate Tier Params", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const treasuryFee = 500;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        treasuryFeeBP: treasuryFee,
      },
    ];

    it("alterTier - reverts if tier id is not exists", async function () {
      await expect(operatorGrid.alterTier(2, tiers[0])).to.be.revertedWithCustomError(operatorGrid, "TierNotExists");
    });

    it("alterTier - validateParams - reverts if reserveRatioBP is less than 0", async function () {
      await expect(operatorGrid.alterTier(0, { ...tiers[0], reserveRatioBP: 0 }))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_reserveRatioBP");
    });

    it("alterTier - validateParams - reverts if reserveRatioBP is greater than 100_00", async function () {
      const _reserveRatioBP = 100_01;
      const totalBasisPoints = 100_00;
      await expect(operatorGrid.alterTier(0, { ...tiers[0], reserveRatioBP: _reserveRatioBP }))
        .to.be.revertedWithCustomError(operatorGrid, "ReserveRatioTooHigh")
        .withArgs("0", _reserveRatioBP, totalBasisPoints);
    });

    it("alterTier - validateParams - reverts if _rebalanceThresholdBP is zero", async function () {
      await expect(operatorGrid.alterTier(0, { ...tiers[0], forcedRebalanceThresholdBP: 0 }))
        .to.be.revertedWithCustomError(operatorGrid, "ZeroArgument")
        .withArgs("_forcedRebalanceThresholdBP");
    });

    it("alterTier - validateParams - reverts if _rebalanceThresholdBP is greater than _reserveRatioBP", async function () {
      const _reserveRatioBP = 2000;
      const _forcedRebalanceThresholdBP = 2100;
      await expect(
        operatorGrid.alterTier(0, {
          ...tiers[0],
          forcedRebalanceThresholdBP: _forcedRebalanceThresholdBP,
          reserveRatioBP: _reserveRatioBP,
        }),
      )
        .to.be.revertedWithCustomError(operatorGrid, "ForcedRebalanceThresholdTooHigh")
        .withArgs("0", _forcedRebalanceThresholdBP, _reserveRatioBP);
    });

    it("alterTier - validateParams - reverts if _treasuryFeeBP is greater than 100_00", async function () {
      const _treasuryFeeBP = 100_01;
      const totalBasisPoints = 100_00;
      await expect(operatorGrid.alterTier(0, { ...tiers[0], treasuryFeeBP: _treasuryFeeBP }))
        .to.be.revertedWithCustomError(operatorGrid, "TreasuryFeeTooHigh")
        .withArgs("0", _treasuryFeeBP, totalBasisPoints);
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
          treasuryFeeBP: 500,
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
          treasuryFeeBP: 500,
        },
      ]);

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit + 1)).to.be.emit(
        operatorGrid,
        "MemberConfirmed",
      );

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit + 1)).to.not.be.reverted;
    });

    it("changeTier should revert if requested share limit is greater than tier share limit", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit + 1);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          treasuryFeeBP: 500,
        },
      ]);

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit + 1)).to.be.emit(
        operatorGrid,
        "MemberConfirmed",
      );

      await expect(
        operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "RequestedShareLimitTooHigh");
    });

    it("Cannot change tier to the default tier", async function () {
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
          treasuryFeeBP: 500,
        },
      ]);

      await expect(operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, 1)).to.be.emit(
        operatorGrid,
        "MemberConfirmed",
      );

      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "TierNotInOperatorGroup",
      );
    });

    it("reverts if Tier already set", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          treasuryFeeBP: 500,
        },
      ]);
      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await expect(
        operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit),
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
          treasuryFeeBP: 500,
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
          treasuryFeeBP: 500,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1001;
      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
        vault: vault_NO1_V1,
        liabilityShares: _liabilityShares,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });
      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares);

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
          treasuryFeeBP: 500,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1000;
      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
        vault: vault_NO1_V1,
        liabilityShares: _liabilityShares,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });
      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares);

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
          treasuryFeeBP: 500,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1000;
      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
        vault: vault_NO1_V1,
        liabilityShares: _liabilityShares,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });
      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, shareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, shareLimit))
        .to.be.emit(operatorGrid, "TierChanged")
        .withArgs(vault_NO1_V1, 1);
    });

    it("works if vault not in default tier ", async function () {
      const shareLimit = 1000;
      await operatorGrid.registerGroup(nodeOperator1, 1000);
      await operatorGrid.registerTiers(nodeOperator1, [
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          treasuryFeeBP: 500,
        },
        {
          shareLimit: shareLimit,
          reserveRatioBP: 2000,
          forcedRebalanceThresholdBP: 1800,
          treasuryFeeBP: 500,
        },
      ]);

      //just for test - update sharesMinted for vaultHub socket
      const _liabilityShares = 1000;
      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
        vault: vault_NO1_V1,
        liabilityShares: _liabilityShares,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });
      //and update tier sharesMinted
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, _liabilityShares);

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
        .withArgs(vault_NO1_V1, 2);

      const tier0after = await operatorGrid.tier(0);
      const tier1after = await operatorGrid.tier(1);
      const tier2after = await operatorGrid.tier(2);
      expect(tier0after.liabilityShares).to.equal(0);
      expect(tier1after.liabilityShares).to.equal(0);
      expect(tier2after.liabilityShares).to.equal(_liabilityShares);
    });
  });

  context("mintShares", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const treasuryFee = 500;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        treasuryFeeBP: treasuryFee,
      },
    ];

    it("mintShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).onMintedShares(vault_NO1_V1, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("mintShares should revert if group shares limit is exceeded", async function () {
      const shareLimit = 999;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierId = 1;
      await expect(operatorGrid.registerTiers(nodeOperator1, tiers))
        .to.be.emit(operatorGrid, "TierAdded")
        .withArgs(nodeOperator1, tierId, tierShareLimit, reserveRatio, forcedRebalanceThreshold, treasuryFee);

      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        forcedRebalanceThresholdBP: forcedRebalanceThreshold,
        treasuryFeeBP: treasuryFee,
        vault: vault_NO1_V1,
        liabilityShares: 0,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, tierShareLimit);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    });

    it("mintShares - group=2000 tier=1000 vault1=1000", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierId = 1;
      await expect(operatorGrid.registerTiers(nodeOperator1, tiers))
        .to.be.emit(operatorGrid, "TierAdded")
        .withArgs(nodeOperator1, tierId, tierShareLimit, reserveRatio, forcedRebalanceThreshold, treasuryFee);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tierId, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tierId, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);

      const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
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
          treasuryFeeBP: treasuryFee,
        },
      ];

      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V2, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");
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
          treasuryFeeBP: treasuryFee,
        },
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          treasuryFeeBP: treasuryFee,
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

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V2, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);
      const group2 = await operatorGrid.group(nodeOperator2);

      const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
      const vaultTier2 = await operatorGrid.vaultInfo(vault_NO2_V2);

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
          treasuryFeeBP: 500,
        },
      ]);

      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
        vault: vault_NO1_V1,
        liabilityShares: 0,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });

      const vaultShareLimit = tierShareLimit / 2;

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, 1, vaultShareLimit);
      await expect(operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, 1, vaultShareLimit))
        .to.emit(vaultHub, "VaultConnectionUpdated")
        .withArgs(vault_NO1_V1, vaultShareLimit, 2000, 1800, 500);
    });
  });

  context("burnShares", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const forcedRebalanceThreshold = 1800;
    const treasuryFee = 500;

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
          treasuryFeeBP: treasuryFee,
        },
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          treasuryFeeBP: treasuryFee,
        },
      ];

      const tier_NO1_Id1 = 1;
      const tier_NO1_Id2 = 2;

      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V1, tier_NO1_Id1, tierShareLimit);

      await operatorGrid.connect(vaultOwner).changeTier(vault_NO1_V2, tier_NO1_Id2, tierShareLimit);
      await operatorGrid.connect(nodeOperator1).changeTier(vault_NO1_V2, tier_NO1_Id2, tierShareLimit);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1);

      await operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);

      const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
      const vaultTier2 = await operatorGrid.vaultInfo(vault_NO1_V2);

      const tier = await operatorGrid.tier(vaultTier.tierId);
      const tier2 = await operatorGrid.tier(vaultTier2.tierId);

      expect(group.liabilityShares).to.equal(1);
      expect(tier.liabilityShares).to.equal(0);
      expect(tier2.liabilityShares).to.equal(1);
    });

    it("burnShares works on DEFAULT_TIER, minted=limit+1, burned=limit", async function () {
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
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
      const treasuryFee = 500;

      const tiers: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          forcedRebalanceThresholdBP: forcedRebalanceThreshold,
          treasuryFeeBP: treasuryFee,
        },
      ];

      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: shareLimit,
        reserveRatioBP: 2000,
        forcedRebalanceThresholdBP: 1800,
        treasuryFeeBP: 500,
        vault: vault_NO1_V1,
        liabilityShares: 0,
        pendingDisconnect: false,
        feeSharesCharged: 0,
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
        retTreasuryFee,
      ] = await operatorGrid.vaultInfo(vault_NO1_V1);

      expect(retGroupOperator).to.equal(nodeOperator1);
      expect(retTierIndex).to.equal(tier_NO1_Id1);
      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retForcedRebalanceThreshold).to.equal(forcedRebalanceThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });
});
