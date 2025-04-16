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

import { certainAddress, ether, impersonate } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const DEFAULT_TIER_SHARE_LIMIT = ether("1000");
const RESERVE_RATIO = 2000;
const RESERVE_RATIO_THRESHOLD = 1800;
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

    await operatorGrid.initialize(deployer, DEFAULT_TIER_SHARE_LIMIT);
    await operatorGrid.grantRole(await operatorGrid.REGISTRY_ROLE(), deployer);

    const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();
    await operatorGrid.alterTier(defaultTierId, {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO,
      rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD,
      treasuryFeeBP: TREASURY_FEE,
    });

    // VaultHub
    vaultHub = await ethers.deployContract("VaultHub__MockForOperatorGrid", []);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    vaultHubAsSigner = await impersonate(await vaultHub.getAddress(), ether("100.0"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on impl initialization", async () => {
      await expect(operatorGrid.initialize(stranger, DEFAULT_TIER_SHARE_LIMIT)).to.be.revertedWithCustomError(
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
      await expect(operatorGridLocal.initialize(ZeroAddress, DEFAULT_TIER_SHARE_LIMIT))
        .to.be.revertedWithCustomError(operatorGridImpl, "ZeroArgument")
        .withArgs("_admin");
    });
  });

  context("Groups", () => {
    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      const shareLimit = 1000;

      await expect(operatorGrid.connect(stranger).registerGroup(ZeroAddress, shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts updating group share limit for non-existent group", async function () {
      const nonExistentGroupId = certainAddress("non-existent-group");
      await expect(operatorGrid.updateGroupShareLimit(nonExistentGroupId, 1234)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupNotExists",
      );
    });

    it("add a new group", async function () {
      const groupOperator = certainAddress("new-operator-group");
      const shareLimit = 2001;

      await expect(operatorGrid.registerGroup(groupOperator, shareLimit))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(groupOperator, shareLimit);

      const groupStruct = await operatorGrid.group(groupOperator);

      expect(groupStruct.shareLimit).to.equal(shareLimit);
      expect(groupStruct.mintedShares).to.equal(0);
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
  });

  context("Tiers", () => {
    const groupId = certainAddress("new-operator-group");
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const reserveRatioThreshold = 1800;
    const treasuryFee = 500;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        rebalanceThresholdBP: reserveRatioThreshold,
        treasuryFeeBP: treasuryFee,
      },
    ];

    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      await expect(operatorGrid.connect(stranger).registerTiers(groupId, tiers)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts if group does not exist", async function () {
      await expect(operatorGrid.registerTiers(groupId, tiers)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupNotExists",
      );
    });
  });

  context("Vaults", () => {
    it("reverts if vault exists", async function () {
      await operatorGrid.registerVault(vault_NO1_V1);
      await expect(operatorGrid.registerVault(vault_NO1_V1)).to.be.revertedWithCustomError(operatorGrid, "VaultExists");
    });

    it("add an vault", async function () {
      await expect(operatorGrid.registerVault(vault_NO1_V1))
        .to.be.emit(operatorGrid, "VaultAdded")
        .withArgs(vault_NO1_V1);
    });
  });

  context("mintShares", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const reserveRatioThreshold = 1800;
    const treasuryFee = 500;
    const tiers: TierParamsStruct[] = [
      {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        rebalanceThresholdBP: reserveRatioThreshold,
        treasuryFeeBP: treasuryFee,
      },
    ];

    it("mintShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).onMintedShares(vault_NO1_V1, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("mintShares should revert if vault not exists", async function () {
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, 100),
      ).to.be.revertedWithCustomError(operatorGrid, "TierNotExists");
    });

    // it("DEFAULT_GROUP mintShares should revert if group shares limit is exceeded", async function () {
    //   const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();
    //   const groupShareLimit = 2000;
    //   await operatorGrid.updateGroupShareLimit(defaultTierId, groupShareLimit);

    //   await operatorGrid.registerVault(vault_NO1_V1);

    //   await expect(
    //     operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, groupShareLimit + 1),
    //   ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    // });

    it("mintShares should revert if group shares limit is exceeded", async function () {
      const shareLimit = 999;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierId = 2;
      await expect(operatorGrid.registerTiers(nodeOperator1, tiers))
        .to.be.emit(operatorGrid, "TierAdded")
        .withArgs(nodeOperator1, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.registerVault(vault_NO1_V1);
      await vaultHub.mock__addVaultSocket(vault_NO1_V1, {
        shareLimit: tierShareLimit,
        reserveRatioBP: reserveRatio,
        rebalanceThresholdBP: reserveRatioThreshold,
        treasuryFeeBP: treasuryFee,
        vault: vault_NO1_V1,
        sharesMinted: 0,
        pendingDisconnect: false,
        feeSharesCharged: 0,
      });

      expect(await operatorGrid.pendingRequestsCount(nodeOperator1)).to.equal(0);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tierId);

      const requests = await operatorGrid.pendingRequests(nodeOperator1);
      expect(requests.length).to.equal(1);
      expect(requests[0]).to.equal(vault_NO1_V1);

      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1, tierId);
      expect(await operatorGrid.pendingRequestsCount(nodeOperator1)).to.equal(0);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    });

    it("mintShares - group=2000 tier=1000 vault1=1000", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierId = 2;
      await expect(operatorGrid.registerTiers(nodeOperator1, tiers))
        .to.be.emit(operatorGrid, "TierAdded")
        .withArgs(nodeOperator1, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tierId);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1, tierId);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);

      const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
      const tier = await operatorGrid.tier(vaultTier.tierId);

      expect(group.mintedShares).to.equal(tierShareLimit);
      expect(tier.mintedShares).to.equal(tierShareLimit);
      expect(tier.operator).to.equal(nodeOperator1);
    });

    // it("mintShares - DEFAULT_GROUP group=2000 tier=2000 NO1_vault1=1999, NO2_vault1=1", async function () {
    //   const groupAddress = await operatorGrid.DEFAULT_GROUP_ADDRESS();
    //   const shareLimit = 1999;

    //   await operatorGrid.registerVault(vault_NO1_V1);
    //   await operatorGrid.registerVault(vault_NO2_V1);

    //   await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, shareLimit - 1);
    //   await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V1, 1);

    //   const group = await operatorGrid.group(groupAddress);

    //   const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
    //   const vaultTier2 = await operatorGrid.vaultInfo(vault_NO2_V1);

    //   const tier = await operatorGrid.tier(vaultTier.tierId);
    //   const tier2 = await operatorGrid.tier(vaultTier2.tierId);

    //   expect(group.mintedShares).to.equal(shareLimit);
    //   expect(tier.mintedShares).to.equal(0); //cause we increase only group limit for default group
    //   expect(tier2.mintedShares).to.equal(0); //cause we increase only group limit for default group
    //   expect(tier.operator).to.equal(groupAddress);
    //   expect(tier2.operator).to.equal(groupAddress);
    // });

    // it("mintShares - DEFAULT_GROUP group=2000 tier=2000 NO1_vault1=1000, NO2_vault2=1, reverts TierLimitExceeded", async function () {
    //   const groupAddress = await operatorGrid.DEFAULT_GROUP_ADDRESS();
    //   const shareLimit = 2000;
    //   await operatorGrid.updateGroupShareLimit(groupAddress, shareLimit);

    //   await operatorGrid.registerVault(vault_NO1_V1);
    //   await operatorGrid.registerVault(vault_NO2_V1);

    //   await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
    //   await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V1, 1);

    //   const group = await operatorGrid.group(groupAddress);

    //   const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
    //   const vaultTier2 = await operatorGrid.vaultInfo(vault_NO2_V1);

    //   const tier = await operatorGrid.tier(vaultTier.tierId);
    //   const tier2 = await operatorGrid.tier(vaultTier2.tierId);

    //   expect(group.mintedShares).to.equal(tierShareLimit + 1);
    //   expect(tier.mintedShares).to.equal(0); //cause we increase only group limit for default group
    //   expect(tier2.mintedShares).to.equal(0); //cause we increase only group limit for default group
    //   expect(tier.operator).to.equal(groupAddress);
    //   expect(tier2.operator).to.equal(groupAddress);
    // });

    it("mintShares - Group1 group=2000 tier=1000 NO1_vault1=1000, NO1_vault2=1, reverts TierLimitExceeded", async function () {
      const shareLimit = 2000;
      const tier_NO1_Id1 = 2;

      const tiers2: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          rebalanceThresholdBP: reserveRatioThreshold,
          treasuryFeeBP: treasuryFee,
        },
      ];

      await operatorGrid.registerGroup(nodeOperator1, shareLimit);
      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tier_NO1_Id1);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1, tier_NO1_Id1);

      await operatorGrid.registerVault(vault_NO1_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V2, tier_NO1_Id1);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V2, tier_NO1_Id1);

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
          rebalanceThresholdBP: reserveRatioThreshold,
          treasuryFeeBP: treasuryFee,
        },
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          rebalanceThresholdBP: reserveRatioThreshold,
          treasuryFeeBP: treasuryFee,
        },
      ];

      const tier_NO1_Id1 = 2;
      const tier_NO1_Id2 = 3;

      const tier_NO2_Id1 = 4;
      const tier_NO2_Id2 = 5;

      await operatorGrid.registerTiers(nodeOperator1, tiers2);
      await operatorGrid.registerTiers(nodeOperator2, tiers2);

      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tier_NO1_Id1);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1, tier_NO1_Id1);

      await operatorGrid.registerVault(vault_NO1_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V2, tier_NO1_Id2);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V2, tier_NO1_Id2);

      await operatorGrid.registerVault(vault_NO2_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO2_V1, tier_NO2_Id1);
      await operatorGrid.connect(nodeOperator2).confirmTierChange(vault_NO2_V1, tier_NO2_Id1);

      await operatorGrid.registerVault(vault_NO2_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO2_V2, tier_NO2_Id2);
      await operatorGrid.connect(nodeOperator2).confirmTierChange(vault_NO2_V2, tier_NO2_Id2);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V2, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);
      const group2 = await operatorGrid.group(nodeOperator2);

      const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
      const vaultTier2 = await operatorGrid.vaultInfo(vault_NO2_V2);

      const tier = await operatorGrid.tier(vaultTier.tierId);
      const tier2 = await operatorGrid.tier(vaultTier2.tierId);

      expect(group.mintedShares).to.equal(tierShareLimit);
      expect(group2.mintedShares).to.equal(tierShareLimit);
      expect(tier.mintedShares).to.equal(tierShareLimit);
      expect(tier2.mintedShares).to.equal(tierShareLimit);
    });
  });

  context("burnShares", () => {
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const reserveRatioThreshold = 1800;
    const treasuryFee = 500;

    it("burnShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).onBurnedShares(vault_NO1_V1, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("burnShares should revert if tier not exists", async function () {
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, 100),
      ).to.be.revertedWithCustomError(operatorGrid, "TierNotExists");
    });

    it("burnShares works, minted=limit+1, burned=limit", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tiers2: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          rebalanceThresholdBP: reserveRatioThreshold,
          treasuryFeeBP: treasuryFee,
        },
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          rebalanceThresholdBP: reserveRatioThreshold,
          treasuryFeeBP: treasuryFee,
        },
      ];

      const tier_NO1_Id1 = 2;
      const tier_NO1_Id2 = 3;

      await operatorGrid.registerTiers(nodeOperator1, tiers2);

      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tier_NO1_Id1);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1, tier_NO1_Id1);

      await operatorGrid.registerVault(vault_NO1_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V2, tier_NO1_Id2);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V2, tier_NO1_Id2);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1);

      await operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, tierShareLimit);

      const group = await operatorGrid.group(nodeOperator1);

      const vaultTier = await operatorGrid.vaultInfo(vault_NO1_V1);
      const vaultTier2 = await operatorGrid.vaultInfo(vault_NO1_V2);

      const tier = await operatorGrid.tier(vaultTier.tierId);
      const tier2 = await operatorGrid.tier(vaultTier2.tierId);

      expect(group.mintedShares).to.equal(1);
      expect(tier.mintedShares).to.equal(0);
      expect(tier2.mintedShares).to.equal(1);
    });
  });

  context("vaultInfo", async function () {
    it("should revert if vault does not exist", async function () {
      await expect(operatorGrid.vaultInfo(ZeroAddress)).to.be.revertedWithCustomError(operatorGrid, "VaultNotExists");
    });

    it("should return correct vault limits", async function () {
      const shareLimit = 2000;
      await operatorGrid.registerGroup(nodeOperator1, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      const tiers: TierParamsStruct[] = [
        {
          shareLimit: tierShareLimit,
          reserveRatioBP: reserveRatio,
          rebalanceThresholdBP: reserveRatioThreshold,
          treasuryFeeBP: treasuryFee,
        },
      ];

      const tier_NO1_Id1 = 2;

      await operatorGrid.registerTiers(nodeOperator1, tiers);
      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tier_NO1_Id1);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1, tier_NO1_Id1);

      const [retGroupOperator, retTierIndex, retShareLimit, retReserveRatio, retReserveRatioThreshold, retTreasuryFee] =
        await operatorGrid.vaultInfo(vault_NO1_V1);

      expect(retGroupOperator).to.equal(nodeOperator1);
      expect(retTierIndex).to.equal(tier_NO1_Id1);
      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retReserveRatioThreshold).to.equal(reserveRatioThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });
});
