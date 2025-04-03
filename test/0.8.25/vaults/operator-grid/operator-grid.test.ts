import { expect } from "chai";
import { keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  BeaconProxy,
  Delegation,
  DepositContract__MockForStakingVault,
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  PredepositGuarantee_HarnessForFactory,
  StakingVault,
  StalingVault__MockForOperatorGrid,
  StETH__MockForOperatorGrid,
  UpgradeableBeacon,
  VaultFactory,
  VaultHub,
  WETH9__MockForVault,
  WstETH__HarnessForVault,
} from "typechain-types";
import { TierParamsStruct } from "typechain-types/contracts/0.8.25/vaults/OperatorGrid";
import { DelegationConfigStruct } from "typechain-types/contracts/0.8.25/vaults/VaultFactory";

import { certainAddress, createVaultProxy, days, /*createVaultProxy,*/ ether, impersonate } from "lib";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot } from "test/suite";

const VAULTS_CONNECTED_VAULTS_LIMIT = 5; // Low limit to test the overflow
const VAULTS_RELATIVE_SHARE_LIMIT_BP = 10_00n;
describe("OperatorGrid.sol", () => {
  let deployer: HardhatEthersSigner;
  let vaultOwner: HardhatEthersSigner;
  let funder: HardhatEthersSigner;
  let withdrawer: HardhatEthersSigner;
  let minter: HardhatEthersSigner;
  let burner: HardhatEthersSigner;
  let rebalancer: HardhatEthersSigner;
  let depositPauser: HardhatEthersSigner;
  let depositResumer: HardhatEthersSigner;
  let exitRequester: HardhatEthersSigner;
  let disconnecter: HardhatEthersSigner;
  let nodeOperatorManager: HardhatEthersSigner;
  let nodeOperatorFeeClaimer: HardhatEthersSigner;
  let dao: HardhatEthersSigner;
  let vaultHubAsSigner: HardhatEthersSigner;

  let stranger: HardhatEthersSigner;
  let beaconOwner: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let steth: StETH__MockForOperatorGrid;
  let weth: WETH9__MockForVault;
  let wsteth: WstETH__HarnessForVault;
  let depositContract: DepositContract__MockForStakingVault;
  let vaultImpl: StakingVault;
  let factory: VaultFactory;
  let delegation: Delegation;
  let beacon: UpgradeableBeacon;
  let vaultHub: VaultHub;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;
  let vault_NO1_C1: StalingVault__MockForOperatorGrid;
  let vault_NO1_C2: StalingVault__MockForOperatorGrid;
  let vault_NO2_C1: StalingVault__MockForOperatorGrid;
  let vault_NO2_C2: StalingVault__MockForOperatorGrid;
  let delegationParams: DelegationConfigStruct;

  let vaultBeaconProxy: BeaconProxy;
  let vaultBeaconProxyCode: string;

  let originalState: string;

  before(async () => {
    [
      deployer,
      vaultOwner,
      funder,
      withdrawer,
      minter,
      burner,
      rebalancer,
      depositPauser,
      depositResumer,
      exitRequester,
      disconnecter,
      nodeOperatorManager,
      nodeOperatorFeeClaimer,
      stranger,
      beaconOwner,
      dao,
    ] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__MockForOperatorGrid");
    weth = await ethers.deployContract("WETH9__MockForVault");
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);

    locator = await deployLidoLocator({ lido: steth, wstETH: wsteth, predepositGuarantee });

    vault_NO1_C1 = await ethers.deployContract("StalingVault__MockForOperatorGrid", [certainAddress("node-operator")]);
    vault_NO1_C2 = await ethers.deployContract("StalingVault__MockForOperatorGrid", [certainAddress("node-operator")]);

    vault_NO2_C1 = await ethers.deployContract("StalingVault__MockForOperatorGrid", [
      certainAddress("node-operator-2"),
    ]);
    vault_NO2_C2 = await ethers.deployContract("StalingVault__MockForOperatorGrid", [
      certainAddress("node-operator-2"),
    ]);

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, deployer, new Uint8Array()], deployer);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, deployer);

    await operatorGrid.initialize(dao);
    await operatorGrid.connect(dao).grantRole(await operatorGrid.REGISTRY_ROLE(), dao);

    // VaultHub
    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      steth,
      operatorGrid,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);
    vaultHub = await ethers.getContractAt("VaultHub", proxy, deployer);
    await expect(vaultHub.initialize(dao)).to.emit(vaultHub, "Initialized").withArgs(1);
    await vaultHub.connect(dao).grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), dao);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee });

    vaultHubAsSigner = await impersonate(await vaultHub.getAddress(), ether("100.0"));

    depositContract = await ethers.deployContract("DepositContract__MockForStakingVault");
    vaultImpl = await ethers.deployContract("StakingVault", [vaultHub, predepositGuarantee, depositContract]);
    expect(await vaultImpl.vaultHub()).to.equal(vaultHub);

    beacon = await ethers.deployContract("UpgradeableBeacon", [vaultImpl, beaconOwner]);

    vaultBeaconProxy = await ethers.deployContract("BeaconProxy", [beacon, "0x"]);
    vaultBeaconProxyCode = await ethers.provider.getCode(await vaultBeaconProxy.getAddress());

    const vaultProxyCodeHash = keccak256(vaultBeaconProxyCode);

    //add proxy code hash to whitelist
    await vaultHub.connect(dao).addVaultProxyCodehash(vaultProxyCodeHash);

    delegation = await ethers.deployContract("Delegation", [weth, locator], { from: deployer });
    factory = await ethers.deployContract("VaultFactory", [beacon, delegation, operatorGrid]);
    expect(await beacon.implementation()).to.equal(vaultImpl);
    expect(await factory.BEACON()).to.equal(beacon);
    expect(await factory.DELEGATION_IMPL()).to.equal(delegation);
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
      const groupId = certainAddress("node-operator");
      const shareLimit = 1000;

      await expect(operatorGrid.connect(stranger).registerGroup(groupId, shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts when adding an existing group", async function () {
      const groupId = certainAddress("default-address");
      const shareLimit = 1000;

      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      await expect(operatorGrid.connect(dao).registerGroup(groupId, shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupExists",
      );
    });

    it("reverts updating group share limit for non-existent group", async function () {
      const nonExistentGroupId = certainAddress("non-existent-group");
      await expect(
        operatorGrid.connect(dao).updateGroupShareLimit(nonExistentGroupId, 1234),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupNotExists");
    });

    it("add a new group", async function () {
      const groupId = certainAddress("new-operator-group");
      const shareLimit = 2001;

      await expect(operatorGrid.connect(dao).registerGroup(groupId, shareLimit))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(groupId, shareLimit);

      const groupStruct = await operatorGrid.group(groupId);

      expect(groupStruct.shareLimit).to.equal(shareLimit);
      expect(groupStruct.mintedShares).to.equal(0);
      expect(groupStruct.tiersId.length).to.equal(0);

      const groupCount = await operatorGrid.groupCount();
      expect(groupCount).to.equal(1);

      const groupStructByIndex = await operatorGrid.groupByIndex(0);
      expect(groupStructByIndex.shareLimit).to.equal(shareLimit);
      expect(groupStructByIndex.mintedShares).to.equal(0);
      expect(groupStructByIndex.tiersId.length).to.equal(0);
    });

    it("reverts when updating without `REGISTRY_ROLE` role", async function () {
      const nonExistentGroupId = certainAddress("non-existent-group");
      await expect(
        operatorGrid.connect(stranger).updateGroupShareLimit(nonExistentGroupId, 2),
      ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
    });

    it("update group share limit", async function () {
      const groupId = certainAddress("new-operator-group");
      const shareLimit = 2000;
      const newShareLimit = 9999;

      await expect(operatorGrid.connect(dao).registerGroup(groupId, shareLimit))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(groupId, shareLimit);

      await expect(operatorGrid.connect(dao).updateGroupShareLimit(groupId, newShareLimit))
        .to.emit(operatorGrid, "GroupShareLimitUpdated")
        .withArgs(groupId, newShareLimit);

      const groupStruct = await operatorGrid.group(groupId);
      expect(groupStruct.shareLimit).to.equal(newShareLimit);
    });
  });

  context("Tiers", () => {
    const groupId = certainAddress("new-operator-group");
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const reserveRatioThreshold = 1800;
    const treasuryFee = 500;

    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      await expect(
        operatorGrid
          .connect(stranger)
          .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee),
      ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
    });

    it("reverts if group does not exist", async function () {
      await expect(
        operatorGrid
          .connect(dao)
          .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupNotExists");
    });
  });

  context("Vaults", () => {
    it("reverts if operator not exists", async function () {
      await expect(operatorGrid.connect(dao).registerVault(vault_NO1_C1)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupNotExists",
      );
    });

    it("reverts if tiers not available", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      await expect(operatorGrid.connect(dao).registerVault(vault_NO1_C1)).to.be.revertedWithCustomError(
        operatorGrid,
        "TiersNotAvailable",
      );
    });

    it("add an vault", async function () {
      const groupId1 = await vault_NO1_C1.nodeOperator();
      const groupId2 = certainAddress("new-operator-group-2");
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId1, shareLimit);
      await operatorGrid.connect(dao).registerGroup(groupId2, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId1, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId2, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await expect(operatorGrid.connect(dao).registerVault(vault_NO1_C1))
        .to.be.emit(operatorGrid, "VaultAdded")
        .withArgs(1, 0, await vault_NO1_C1.getAddress());
    });
  });

  context("mintShares", () => {
    it("mintShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).onMintedShares(vault_NO1_C1, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("mintShares should revert if vault not exists", async function () {
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, 100),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultNotExists");
    });

    it("mintShares should revert if tier shares limit is exceeded", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const groupShareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, groupShareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");
    });

    it("mintShares should revert if group shares limit is exceeded", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const shareLimit = 999;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    });

    it("mintShares - group=2000 tier=1000 vault1=1000", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);

      const [retGroupIndex, retTierIndex] = await operatorGrid.getVaultInfo(vault_NO1_C1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO1_C1.getAddress(), retGroupIndex, retTierIndex, tierShareLimit, tierShareLimit);
    });

    it("mintShares - DEFAULT_GROUP group=2000 tier=1000 NO1_vault1=999, NO2_vault2=1", async function () {
      const groupId = await operatorGrid.DEFAULT_GROUP_OPERATOR_ADDRESS();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);
      await operatorGrid.connect(dao).registerVault(vault_NO2_C1);

      const [retGroupIndex, retTierIndex] = await operatorGrid.getVaultInfo(vault_NO1_C1);
      const [retGroupIndex2, retTierIndex2] = await operatorGrid.getVaultInfo(vault_NO2_C1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit - 1))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO1_C1.getAddress(), retGroupIndex, retTierIndex, tierShareLimit - 1, tierShareLimit - 1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_C1, 1))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO2_C1.getAddress(), retGroupIndex2, retTierIndex2, tierShareLimit, tierShareLimit);
    });

    it("mintShares - DEFAULT_GROUP group=2000 tier=1000 NO1_vault1=1000, NO2_vault2=1, reverts TierLimitExceeded", async function () {
      const groupId = await operatorGrid.DEFAULT_GROUP_OPERATOR_ADDRESS();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);
      await operatorGrid.connect(dao).registerVault(vault_NO2_C1);

      const [retGroupIndex, retTierIndex] = await operatorGrid.getVaultInfo(vault_NO1_C1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO1_C1.getAddress(), retGroupIndex, retTierIndex, tierShareLimit, tierShareLimit);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_C1, 1),
      ).to.be.revertedWithCustomError(operatorGrid, "TierLimitExceeded");
    });

    it("mintShares - group1=2000, group2=1000, g1Tier1=1000, g2Tier1=1000", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const groupId2 = await vault_NO2_C1.nodeOperator();
      const shareLimit = 2000;
      const shareLimit2 = 1000;

      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);
      await operatorGrid.connect(dao).registerGroup(groupId2, shareLimit2);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      const tiers1: TierParamsStruct[] = [
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

      await operatorGrid.connect(dao).registerTiers(groupId, tiers1);
      await operatorGrid.connect(dao).registerTiers(groupId2, tiers1);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);
      await operatorGrid.connect(dao).registerVault(vault_NO1_C2);

      await operatorGrid.connect(dao).registerVault(vault_NO2_C1);
      await operatorGrid.connect(dao).registerVault(vault_NO2_C2);

      const [retGroupIndex, retTierIndex] = await operatorGrid.getVaultInfo(vault_NO1_C1);
      const [retGroupIndex2, retTierIndex2] = await operatorGrid.getVaultInfo(vault_NO2_C2);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO1_C1.getAddress(), retGroupIndex, retTierIndex, tierShareLimit, tierShareLimit);

      await expect(operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO2_C2, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO2_C2.getAddress(), retGroupIndex2, retTierIndex2, tierShareLimit, tierShareLimit);
    });
  });

  context("burnShares", () => {
    it("burnShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).onBurnedShares(vault_NO1_C1, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("burnShares should revert if vault not exists", async function () {
      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_C1, 100),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultNotExists");
    });

    it("burnShares should revert if group shares limit is underflow", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_C1, 1),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupMintedSharesUnderflow");
    });

    it("burnShares should revert if vault shares limit is underflow", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);
      await operatorGrid.connect(dao).registerVault(vault_NO1_C2);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C2, 1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_C1, tierShareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "TierMintedSharesUnderflow");
    });

    it("burnShares works", async function () {
      const groupId = await vault_NO1_C1.nodeOperator();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);
      await operatorGrid.connect(dao).registerVault(vault_NO1_C2);

      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C1, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).onMintedShares(vault_NO1_C2, 1);

      const [retGroupIndex, retTierIndex] = await operatorGrid.getVaultInfo(vault_NO1_C1);

      await expect(operatorGrid.connect(vaultHubAsSigner).onBurnedShares(vault_NO1_C1, tierShareLimit))
        .to.be.emit(operatorGrid, "SharesLimitChanged")
        .withArgs(await vault_NO1_C1.getAddress(), retGroupIndex, retTierIndex, 0, 1);
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
      const groupId = await vault_NO1_C1.nodeOperator();
      const groupId2 = await vault_NO2_C1.nodeOperator();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);
      await operatorGrid.connect(dao).registerGroup(groupId2, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId2, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await operatorGrid.connect(dao).registerVault(vault_NO1_C1);

      const [retGroupIndex, retTierIndex, retShareLimit, retReserveRatio, retReserveRatioThreshold, retTreasuryFee] =
        await operatorGrid.getVaultInfo(vault_NO1_C1);

      expect(retGroupIndex).to.equal(1);
      expect(retTierIndex).to.equal(1);
      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retReserveRatioThreshold).to.equal(reserveRatioThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });

  context("VaultFactory - createVault", async function () {
    it("creates a vault", async function () {
      const groupId = await operatorGrid.DEFAULT_GROUP_OPERATOR_ADDRESS();
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      delegationParams = {
        defaultAdmin: vaultOwner,
        nodeOperatorManager,
        assetRecoverer: vaultOwner,
        confirmExpiry: days(7n),
        nodeOperatorFeeBP: 200n,
        funders: [funder],
        withdrawers: [withdrawer],
        minters: [minter],
        burners: [burner],
        rebalancers: [rebalancer],
        depositPausers: [depositPauser],
        depositResumers: [depositResumer],
        validatorExitRequesters: [exitRequester],
        validatorWithdrawalTriggerers: [vaultOwner],
        disconnecters: [disconnecter],
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimer],
      };

      const { vault } = await createVaultProxy(vaultOwner, factory, delegationParams);

      const [retGroupIndex, retTierIndex, retShareLimit, retReserveRatio, retReserveRatioThreshold, retTreasuryFee] =
        await operatorGrid.getVaultInfo(vault);

      expect(retGroupIndex).to.equal(1);
      expect(retTierIndex).to.equal(0);
      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retReserveRatioThreshold).to.equal(reserveRatioThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });
});
