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
  let curatorFeeSetter: HardhatEthersSigner;
  let curatorFeeClaimer: HardhatEthersSigner;
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
  let vaultMock: StalingVault__MockForOperatorGrid;
  let vaultMock2: StalingVault__MockForOperatorGrid;
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
      curatorFeeSetter,
      curatorFeeClaimer,
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

    vaultMock = await ethers.deployContract("StalingVault__MockForOperatorGrid", [certainAddress("node-operator")]);
    vaultMock2 = await ethers.deployContract("StalingVault__MockForOperatorGrid", [certainAddress("node-operator")]);

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
      const groupId = 1;
      const shareLimit = 1000;

      await expect(operatorGrid.connect(stranger).registerGroup(groupId, shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("reverts when adding an existing group", async function () {
      const groupId = 1;
      const shareLimit = 1000;

      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      await expect(operatorGrid.connect(dao).registerGroup(groupId, shareLimit)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupExists",
      );
    });

    it("reverts updating group share limit for non-existent group", async function () {
      await expect(operatorGrid.connect(dao).updateGroupShareLimit(999, 1234)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupNotExists",
      );
    });

    it("add a new group", async function () {
      const groupId = 2;
      const shareLimit = 2001;

      await expect(operatorGrid.connect(dao).registerGroup(groupId, shareLimit))
        .to.emit(operatorGrid, "GroupAdded")
        .withArgs(groupId, shareLimit);

      const groupStruct = await operatorGrid.group(groupId);

      expect(groupStruct.shareLimit).to.equal(shareLimit);
      expect(groupStruct.mintedShares).to.equal(0);
      expect(groupStruct.tiersCount).to.equal(0);

      const groupCount = await operatorGrid.groupCount();
      expect(groupCount).to.equal(1);

      const groupStructByIndex = await operatorGrid.groupByIndex(0);
      expect(groupStructByIndex.shareLimit).to.equal(shareLimit);
      expect(groupStructByIndex.mintedShares).to.equal(0);
      expect(groupStructByIndex.tiersCount).to.equal(0);
    });

    it("reverts when updating without `REGISTRY_ROLE` role", async function () {
      await expect(operatorGrid.connect(stranger).updateGroupShareLimit(1, 2)).to.be.revertedWithCustomError(
        operatorGrid,
        "AccessControlUnauthorizedAccount",
      );
    });

    it("update group share limit", async function () {
      const groupId = 2;
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
    const groupId = 2;
    const tierId = 1;
    const tierShareLimit = 1000;
    const reserveRatio = 2000;
    const reserveRatioThreshold = 1800;
    const treasuryFee = 500;

    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      await expect(
        operatorGrid
          .connect(stranger)
          .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee),
      ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
    });

    it("reverts if group does not exist", async function () {
      await expect(
        operatorGrid
          .connect(dao)
          .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupNotExists");
    });

    it("reverts if tier already exists", async function () {
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      await expect(
        operatorGrid
          .connect(dao)
          .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee),
      ).to.be.revertedWithCustomError(operatorGrid, "TierExists");
    });
  });

  context("Operators", () => {
    it("reverts when adding without `REGISTRY_ROLE` role", async function () {
      await expect(
        operatorGrid.connect(stranger)["registerOperator(address,uint256)"](ZeroAddress, 999),
      ).to.be.revertedWithCustomError(operatorGrid, "AccessControlUnauthorizedAccount");
    });

    it("reverts if operator is 0 address", async function () {
      await expect(operatorGrid.connect(dao)["registerOperator(address)"](ZeroAddress)).to.be.revertedWithCustomError(
        operatorGrid,
        "ZeroArgument",
      );
    });

    it("reverts if group does not exist", async function () {
      const operatorAddress = certainAddress("operator-address");
      await expect(
        operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, 999),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupNotExists");
    });

    it("add an operator by default", async function () {
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(1, shareLimit);
      await operatorGrid.connect(dao).registerGroup(2, shareLimit);

      const operatorAddress = certainAddress("operator-address");

      await expect(operatorGrid.connect(dao)["registerOperator(address)"](operatorAddress))
        .to.emit(operatorGrid, "NodeOperatorAdded")
        .withArgs(1, operatorAddress);

      const opStruct = await operatorGrid.nodeOperator(operatorAddress);
      expect(opStruct.groupId).to.equal(1);
      expect(opStruct.vaultsCount).to.equal(0);

      const nodeOperatorCount = await operatorGrid.nodeOperatorCount();
      expect(nodeOperatorCount).to.equal(1);

      const opStructByIndex = await operatorGrid.nodeOperatorByIndex(0);
      expect(opStructByIndex.groupId).to.equal(1);
      expect(opStructByIndex.vaultsCount).to.equal(0);
      expect(opStructByIndex.nodeOperatorAddress).to.equal(operatorAddress);
    });

    it("add an operator", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const operatorAddress = certainAddress("operator-address");

      await expect(operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId))
        .to.emit(operatorGrid, "NodeOperatorAdded")
        .withArgs(groupId, operatorAddress);

      const opStruct = await operatorGrid.nodeOperator(operatorAddress);
      expect(opStruct.groupId).to.equal(groupId);
      expect(opStruct.vaultsCount).to.equal(0);
    });

    it("reverts when registering the same operator again", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const operatorAddress = certainAddress("operator-address");

      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);

      await expect(
        operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, 2),
      ).to.be.revertedWithCustomError(operatorGrid, "NodeOperatorExists");
    });
  });

  context("Vaults", () => {
    it("reverts if operator not exists", async function () {
      await expect(operatorGrid.connect(dao).registerVault(vaultMock)).to.be.revertedWithCustomError(
        operatorGrid,
        "NodeOperatorNotExists",
      );
    });

    it("reverts if tiers not available", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);

      await expect(operatorGrid.connect(dao).registerVault(vaultMock)).to.be.revertedWithCustomError(
        operatorGrid,
        "TiersNotAvailable",
      );
    });

    it("add an vault", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);
      await operatorGrid.connect(dao).registerGroup(3, shareLimit);

      const tierId = 2;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(3, 1, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);

      await expect(operatorGrid.connect(dao).registerVault(vaultMock))
        .to.be.emit(operatorGrid, "VaultAdded")
        .withArgs(groupId, operatorAddress, await vaultMock.getAddress(), 2);
    });
  });

  context("mintShares", () => {
    it("mintShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).mintShares(vaultMock, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("mintShares should revert if vault not exists", async function () {
      await expect(operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultNotExists",
      );
    });

    it("mintShares should revert if group shares limit is exceeded", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 1;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);
      await operatorGrid.connect(dao).registerVault(vaultMock);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock, shareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "GroupLimitExceeded");
    });

    it("mintShares should revert if vault shares limit is exceeded", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 1;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);
      await operatorGrid.connect(dao).registerVault(vaultMock);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock, tierShareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultTierLimitExceeded");
    });

    it("mintShares works", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 1;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);
      await operatorGrid.connect(dao).registerVault(vaultMock);

      await expect(operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock, tierShareLimit - 1))
        .to.be.emit(operatorGrid, "Minted")
        .withArgs(groupId, operatorAddress, await vaultMock.getAddress(), tierShareLimit - 1);
    });
  });

  context("burnShares", () => {
    it("burnShares should revert if sender is not `VaultHub`", async function () {
      await expect(operatorGrid.connect(stranger).burnShares(vaultMock, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "NotAuthorized",
      );
    });

    it("burnShares should revert if vault not exists", async function () {
      await expect(operatorGrid.connect(vaultHubAsSigner).burnShares(vaultMock, 100)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultNotExists",
      );
    });

    it("burnShares should revert if group shares limit is underflow", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 1;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);
      await operatorGrid.connect(dao).registerVault(vaultMock);

      await expect(operatorGrid.connect(vaultHubAsSigner).burnShares(vaultMock, 1)).to.be.revertedWithCustomError(
        operatorGrid,
        "GroupMintedSharesUnderflow",
      );
    });

    it("burnShares should revert if vault shares limit is underflow", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 1;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, 2, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);
      await operatorGrid.connect(dao).registerVault(vaultMock);
      await operatorGrid.connect(dao).registerVault(vaultMock2);

      await operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock2, 1);

      await expect(
        operatorGrid.connect(vaultHubAsSigner).burnShares(vaultMock, tierShareLimit + 1),
      ).to.be.revertedWithCustomError(operatorGrid, "VaultMintedSharesUnderflow");
    });

    it("burnShares works", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 1;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, 2, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);
      await operatorGrid.connect(dao).registerVault(vaultMock);
      await operatorGrid.connect(dao).registerVault(vaultMock2);

      await operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock, tierShareLimit);
      await operatorGrid.connect(vaultHubAsSigner).mintShares(vaultMock2, 1);

      await expect(operatorGrid.connect(vaultHubAsSigner).burnShares(vaultMock, tierShareLimit))
        .to.be.emit(operatorGrid, "Burned")
        .withArgs(groupId, operatorAddress, await vaultMock.getAddress(), tierShareLimit);
    });
  });

  context("getVaultLimits", async function () {
    it("should revert if vault does not exist", async function () {
      await expect(operatorGrid.getVaultLimits(ZeroAddress)).to.be.revertedWithCustomError(
        operatorGrid,
        "VaultNotExists",
      );
    });

    it("should return correct vault limits", async function () {
      const groupId = 2;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);
      await operatorGrid.connect(dao).registerGroup(3, shareLimit);

      const tierId = 2;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;

      await operatorGrid
        .connect(dao)
        .registerTier(3, 1, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);

      const operatorAddress = vaultMock.nodeOperator();
      await operatorGrid.connect(dao)["registerOperator(address,uint256)"](operatorAddress, groupId);

      await operatorGrid.connect(dao).registerVault(vaultMock);

      const [retShareLimit, retReserveRatio, retReserveRatioThreshold, retTreasuryFee] =
        await operatorGrid.getVaultLimits(vaultMock);

      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retReserveRatioThreshold).to.equal(reserveRatioThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });

  context("VaultFactory - createVault", async function () {
    it("creates a vault", async function () {
      const groupId = 1;
      const shareLimit = 2000;
      await operatorGrid.connect(dao).registerGroup(groupId, shareLimit);

      const tierId = 2;
      const tierShareLimit = 1000;
      const reserveRatio = 2000;
      const reserveRatioThreshold = 1800;
      const treasuryFee = 500;
      await operatorGrid
        .connect(dao)
        .registerTier(groupId, tierId, tierShareLimit, reserveRatio, reserveRatioThreshold, treasuryFee);
      await operatorGrid.connect(stranger)["registerOperator(address)"](nodeOperatorManager);

      delegationParams = {
        defaultAdmin: vaultOwner,
        nodeOperatorManager,
        confirmExpiry: days(7n),
        curatorFeeBP: 100n,
        nodeOperatorFeeBP: 200n,
        funders: [funder],
        withdrawers: [withdrawer],
        minters: [minter],
        burners: [burner],
        curatorFeeSetters: [curatorFeeSetter],
        curatorFeeClaimers: [curatorFeeClaimer],
        nodeOperatorFeeClaimers: [nodeOperatorFeeClaimer],
        rebalancers: [rebalancer],
        depositPausers: [depositPauser],
        depositResumers: [depositResumer],
        validatorExitRequesters: [exitRequester],
        validatorWithdrawalTriggerers: [vaultOwner],
        disconnecters: [disconnecter],
        assetRecoverer: vaultOwner,
      };

      const { vault } = await createVaultProxy(vaultOwner, factory, delegationParams);

      const [retShareLimit, retReserveRatio, retReserveRatioThreshold, retTreasuryFee] =
        await operatorGrid.getVaultLimits(vault);

      expect(retShareLimit).to.equal(tierShareLimit);
      expect(retReserveRatio).to.equal(reserveRatio);
      expect(retReserveRatioThreshold).to.equal(reserveRatioThreshold);
      expect(retTreasuryFee).to.equal(treasuryFee);
    });
  });
});
