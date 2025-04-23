import { expect } from "chai";
import { ContractTransactionReceipt, keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  OperatorGrid,
  OperatorGrid__MockForVaultHub,
  PredepositGuarantee_HarnessForFactory,
  StakingVault__MockForVaultHub,
  StETH__HarnessForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { DEPOSIT_DOMAIN, impersonate } from "lib";
import { findEvents } from "lib/event";
import { ether } from "lib/units";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const SHARE_LIMIT = ether("10");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

describe("VaultHub.sol:forceRebalance", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let vaultHubSigner: HardhatEthersSigner;

  let vaultHub: VaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let vault: StakingVault__MockForVaultHub;
  let steth: StETH__HarnessForVaultHub;
  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let operatorGrid: OperatorGrid;
  let operatorGridMock: OperatorGrid__MockForVaultHub;

  let vaultAddress: string;

  let originalState: string;

  // Simulate getting in the unhealthy state
  const mintStETHAndSlashVault = async () => {
    await vaultHub.connect(user).mintShares(vaultAddress, user, ether("0.9"));
    await vault.connect(vaultHubSigner).report(0n, ether("0.9"), ether("1"), ether("1")); // slashing
  };

  before(async () => {
    [deployer, user] = await ethers.getSigners();
    const depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("1000.0") });
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
      DEPOSIT_DOMAIN,
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);
    locator = await deployLidoLocator({
      lido: steth,
      predepositGuarantee: predepositGuarantee,
    });

    // OperatorGrid
    operatorGridMock = await ethers.deployContract("OperatorGrid__MockForVaultHub", [], { from: deployer });
    operatorGrid = await ethers.getContractAt("OperatorGrid", operatorGridMock, deployer);
    await operatorGridMock.initialize(ether("1"));

    await updateLidoLocatorImplementation(await locator.getAddress(), { operatorGrid });

    const vaultHubImpl = await ethers.deployContract("VaultHub", [locator, steth, VAULTS_RELATIVE_SHARE_LIMIT_BP]);
    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
    vaultHubSigner = await impersonate(await vaultHub.getAddress(), ether("10000.0"));

    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [vaultHub, depositContract]);
    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [await stakingVaultImpl.getAddress()]);

    const vaultCreationTx = (await vaultFactory
      .createVault(user, user, predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    vault = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
    vaultAddress = await vault.getAddress();

    const codehash = keccak256(await ethers.provider.getCode(vaultAddress));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);

    await operatorGridMock.changeVaultTierParams(vaultAddress, {
      shareLimit: SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO_BP,
      forcedRebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
      treasuryFeeBP: TREASURY_FEE_BP,
    });

    const connectDeposit = ether("1.0");
    await vault.connect(user).fund({ value: connectDeposit });
    await vault.connect(user).lock(connectDeposit);

    await vaultHub.connect(user).connectVault(vaultAddress);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));
  afterEach(async () => await Snapshot.restore(originalState));

  it("reverts if vault is zero address", async () => {
    await expect(vaultHub.forceRebalance(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
      .withArgs("_vault");
  });

  it("reverts if vault is not connected to the hub", async () => {
    const vaultCreationTx = (await vaultFactory
      .createVault(user, user, predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    await expect(vaultHub.forceRebalance(vaultCreatedEvent.args.vault))
      .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
      .withArgs(vaultCreatedEvent.args.vault);
  });

  it("reverts if called for a disconnected vault", async () => {
    await vaultHub.connect(user).disconnect(vaultAddress);

    await expect(vaultHub.forceRebalance(vaultAddress))
      .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
      .withArgs(vaultAddress);
  });

  context("unhealthy vault", () => {
    beforeEach(async () => await mintStETHAndSlashVault());

    it("rebalances the vault with available balance", async () => {
      const sharesMintedBefore = (await vaultHub["vaultSocket(address)"](vaultAddress)).liabilityShares;
      const balanceBefore = await ethers.provider.getBalance(vaultAddress);
      const expectedRebalanceAmount = await vaultHub.rebalanceShortfall(vaultAddress);
      const expectedSharesToBeBurned = await steth.getSharesByPooledEth(expectedRebalanceAmount);

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, expectedSharesToBeBurned);

      const balanceAfter = await ethers.provider.getBalance(vaultAddress);
      expect(balanceAfter).to.equal(balanceBefore - expectedRebalanceAmount);

      const sharesMintedAfter = (await vaultHub["vaultSocket(address)"](vaultAddress)).liabilityShares;
      expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);
    });

    it("rebalances with maximum available amount if shortfall exceeds balance", async () => {
      await vault.connect(user).mock__increaseTotalValue(ether("1.0"));
      await vault.connect(user).lock(ether("1.0"));
      await vaultHub.connect(user).mintShares(vaultAddress, user, ether("0.5"));
      await vault.connect(user).mock__decreaseTotalValue(ether("1.0"));

      const sharesMintedBefore = (await vaultHub["vaultSocket(address)"](vaultAddress)).liabilityShares;
      const expectedRebalanceAmount = await ethers.provider.getBalance(vaultAddress);
      const expectedSharesToBeBurned = await steth.getSharesByPooledEth(expectedRebalanceAmount);

      await expect(vaultHub.forceRebalance(vaultAddress))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, expectedSharesToBeBurned);

      const balanceAfter = await ethers.provider.getBalance(vaultAddress);
      expect(balanceAfter).to.equal(0);

      const sharesMintedAfter = (await vaultHub["vaultSocket(address)"](vaultAddress)).liabilityShares;
      expect(sharesMintedAfter).to.equal(sharesMintedBefore - expectedSharesToBeBurned);
    });

    it("can be called by anyone", async () => {
      const stranger = (await ethers.getSigners())[9];
      const balanceBefore = await ethers.provider.getBalance(vaultAddress);
      const shortfall = await vaultHub.rebalanceShortfall(vaultAddress);
      const expectedRebalanceAmount = shortfall < balanceBefore ? shortfall : balanceBefore;
      const expectedSharesToBeBurned = await steth.getSharesByPooledEth(expectedRebalanceAmount);

      await expect(vaultHub.connect(stranger).forceRebalance(vaultAddress))
        .to.emit(vaultHub, "VaultRebalanced")
        .withArgs(vaultAddress, expectedSharesToBeBurned);
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
