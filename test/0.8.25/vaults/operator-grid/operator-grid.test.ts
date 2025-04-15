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

const SHARE_LIMIT = 1000;
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

    await operatorGrid.initialize(deployer);
    await operatorGrid.grantRole(await operatorGrid.REGISTRY_ROLE(), deployer);

    const DEFAULT_GROUP_ADDRESS = await operatorGrid.DEFAULT_GROUP_ADDRESS();
    await operatorGrid.registerGroup(DEFAULT_GROUP_ADDRESS, 1000);
    await operatorGrid.registerTiers(DEFAULT_GROUP_ADDRESS, [
      {
        shareLimit: SHARE_LIMIT,
        reserveRatioBP: RESERVE_RATIO,
        rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD,
        treasuryFeeBP: TREASURY_FEE,
      },
    ]);

    // VaultHub
    vaultHub = await ethers.deployContract("VaultHub__MockForOperatorGrid", []);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    vaultHubAsSigner = await impersonate(await vaultHub.getAddress(), ether("100.0"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on impl initialization", async () => {
      await expect(operatorGrid.initialize(stranger)).to.be.revertedWithCustomError(
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
      await expect(operatorGridLocal.initialize(ZeroAddress))
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
      expect(groupStruct.tiersId.length).to.equal(0);
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
      const DEFAULT_GROUP_ADDRESS = await operatorGrid.DEFAULT_GROUP_ADDRESS();
      await expect(operatorGrid.registerVault(vault_NO1_V1))
        .to.be.emit(operatorGrid, "VaultAdded")
        .withArgs(DEFAULT_GROUP_ADDRESS, 1, await vault_NO1_V1.getAddress());
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
      ).to.be.revertedWithCustomError(operatorGrid, "VaultNotExists");
    });

    it("mintShares should revert if tier shares limit is exceeded", async function () {
      const DEFAULT_GROUP_ADDRESS = await operatorGrid.DEFAULT_GROUP_ADDRESS();
      const groupShareLimit = 2000;
      await operatorGrid.updateGroupShareLimit(DEFAULT_GROUP_ADDRESS, groupShareLimit);

      await operatorGrid.registerVault(vault_NO1_V1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");
    });

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

      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V1, tierId);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1);

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
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(nodeOperator1, tierId, vault_NO1_V1, tierShareLimit, tierShareLimit);
    });

    it("mintShares - DEFAULT_GROUP group=2000 tier=1000 NO1_vault1=999, NO2_vault2=1", async function () {
      const groupAddress = await operatorGrid.DEFAULT_GROUP_ADDRESS();
      const shareLimit = 2000;
      await operatorGrid.updateGroupShareLimit(groupAddress, shareLimit);

      const tierId = 1;

      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.registerVault(vault_NO2_V1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit - 1))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(groupAddress, tierId, vault_NO1_V1, tierShareLimit - 1, tierShareLimit - 1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V1, 1))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(groupAddress, tierId, vault_NO2_V1, 1000, 1000);
    });

    it("mintShares - DEFAULT_GROUP group=2000 tier=1000 NO1_vault1=1000, NO2_vault2=1, reverts TierLimitExceeded", async function () {
      const groupAddress = await operatorGrid.DEFAULT_GROUP_ADDRESS();
      const shareLimit = 2000;
      await operatorGrid.updateGroupShareLimit(groupAddress, shareLimit);

      const tierId = 1;

      await operatorGrid.registerVault(vault_NO1_V1);
      await operatorGrid.registerVault(vault_NO2_V1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(groupAddress, tierId, vault_NO1_V1, tierShareLimit, tierShareLimit);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V1, 1),
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
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1);

      await operatorGrid.registerVault(vault_NO1_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V2, tier_NO1_Id2);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V2);

      await operatorGrid.registerVault(vault_NO2_V1);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO2_V1, tier_NO2_Id1);
      await operatorGrid.connect(nodeOperator2).confirmTierChange(vault_NO2_V1);

      await operatorGrid.registerVault(vault_NO2_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO2_V2, tier_NO2_Id2);
      await operatorGrid.connect(nodeOperator2).confirmTierChange(vault_NO2_V2);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(nodeOperator1, tier_NO1_Id1, vault_NO1_V1, tierShareLimit, tierShareLimit);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_V2, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(nodeOperator2, tier_NO2_Id2, vault_NO2_V2, tierShareLimit, tierShareLimit);
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

    it("burnShares should revert if vault not exists", async function () {
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, 100),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultNotExists");
    });

    it("burnShares should revert if group shares limit is underflow", async function () {
      await operatorGrid.registerVault(vault_NO1_V1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, 1),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupMintedSharesUnderflow");
    });

    it("burnShares should revert if tier shares limit is underflow", async function () {
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
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1);

      await operatorGrid.registerVault(vault_NO1_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V2, tier_NO1_Id2);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V2);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, tierShareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "TierMintedSharesUnderflow");
    });

    it("burnShares works", async function () {
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
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1);

      await operatorGrid.registerVault(vault_NO1_V2);
      await operatorGrid.connect(vaultOwner).requestTierChange(vault_NO1_V2, tier_NO1_Id2);
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V2);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_V2, 1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_V1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(nodeOperator1, tier_NO1_Id1, vault_NO1_V1, 0, 1);
    });
  });

  context("getVaultInfo", async function () {
    it("should revert if vault does not exist", async function () {
      await expect(operatorGrid.getVaultInfo(ZeroAddress)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultNotExists",
      );
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
      await operatorGrid.connect(nodeOperator1).confirmTierChange(vault_NO1_V1);

      const [retGroupOperator, retTierIndex, retShareLimit, retReserveRatio, retReserveRatioThreshold, retTreasuryFee] =
        await operatorGrid.getVaultInfo(vault_NO1_V1);

      expect(retGroupOperator).to.equal(nodeOperator1);
      expect(retTierIndex).to.equal(tier_NO1_Id1);
      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retReserveRatioThreshold).to.equal(reserveRatioThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });
});
