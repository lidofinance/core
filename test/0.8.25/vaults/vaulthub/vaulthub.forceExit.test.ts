import { expect } from "chai";
import { ContractTransactionReceipt, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  OperatorGrid,
  PredepositGuarantee_HarnessForFactory,
  StakingVault__MockForVaultHub,
  StETH__HarnessForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { impersonate } from "lib";
import { findEvents } from "lib/event";
import { ether } from "lib/units";

import { deployLidoLocator, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_CONNECTED_VAULTS_LIMIT, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

const SHARE_LIMIT = ether("1");
const TOTAL_BASIS_POINTS = 10_000n;
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const FEE = 2n;

describe("VaultHub.sol:forceExit", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;

  let vaultHub: VaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let vault: StakingVault__MockForVaultHub;
  let steth: StETH__HarnessForVaultHub;
  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let operatorGrid: OperatorGrid;

  let vaultAddress: string;
  let vaultHubAddress: string;

  let vaultHubSigner: HardhatEthersSigner;

  let originalState: string;

  async function registerVaultWithTier(
    vault_: StakingVault__MockForVaultHub,
    options?: {
      shareLimit?: bigint;
      reserveRatioBP?: bigint;
      rebalanceThresholdBP?: bigint;
      treasuryFeeBP?: bigint;
    },
  ) {
    const groupId = 1;
    const tiersCount = (await operatorGrid.groups(groupId)).tiersCount;
    const nextTierId = tiersCount + 1n;

    await operatorGrid
      .connect(user)
      .registerTier(
        groupId,
        nextTierId,
        options?.shareLimit ?? SHARE_LIMIT,
        options?.reserveRatioBP ?? RESERVE_RATIO_BP,
        options?.rebalanceThresholdBP ?? RESERVE_RATIO_THRESHOLD_BP,
        options?.treasuryFeeBP ?? TREASURY_FEE_BP,
      );

    await operatorGrid.connect(user).registerVault(vault_);
  }

  before(async () => {
    [deployer, user, stranger, feeRecipient] = await ethers.getSigners();
    const depositContract = await ethers.deployContract("DepositContract__MockForVaultHub");
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("10000.0") });
    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      0,
    ]);
    locator = await deployLidoLocator({
      lido: steth,
      predepositGuarantee: predepositGuarantee,
    });

    operatorGrid = await ethers.deployContract("OperatorGrid", [locator, user]);

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      steth,
      operatorGrid,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
    vaultHubAddress = await vaultHub.getAddress();

    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [
      await vaultHub.getAddress(),
      await locator.predepositGuarantee(),
      depositContract,
    ]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [await stakingVaultImpl.getAddress()]);

    const vaultCreationTx = (await vaultFactory
      .createVault(user, user)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    vault = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
    vaultAddress = await vault.getAddress();

    const codehash = keccak256(await ethers.provider.getCode(vaultAddress));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);

    await operatorGrid.connect(user).grantRole(await operatorGrid.REGISTRY_ROLE(), user);
    await operatorGrid.connect(user).registerGroup(1, ether("100"));
    await operatorGrid.connect(user)["registerOperator(address)"](user);

    await registerVaultWithTier(vault, {
      shareLimit: SHARE_LIMIT,
      reserveRatioBP: RESERVE_RATIO_BP,
      rebalanceThresholdBP: RESERVE_RATIO_THRESHOLD_BP,
      treasuryFeeBP: TREASURY_FEE_BP,
    });

    await vaultHub.connect(user).connectVault(vaultAddress);

    vaultHubSigner = await impersonate(vaultHubAddress, ether("100"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // Simulate getting in the unhealthy state
  const makeVaultUnhealthy = async () => {
    await vault.fund({ value: ether("1") });
    await vaultHub.mintShares(vaultAddress, user, ether("0.9"));
    await vault.connect(vaultHubSigner).report(ether("0.9"), ether("1"), ether("1.1")); // slashing
  };

  context("forceValidatorExit", () => {
    it("reverts if msg.value is 0", async () => {
      await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 0n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if the vault is zero address", async () => {
      await expect(vaultHub.forceValidatorExit(ZeroAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts if zero pubkeys", async () => {
      await expect(vaultHub.forceValidatorExit(vaultAddress, "0x", feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("reverts if zero refund recipient", async () => {
      await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, ZeroAddress, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_refundRecipient");
    });

    it("reverts if pubkeys are not valid", async () => {
      await expect(
        vaultHub.forceValidatorExit(vaultAddress, "0x" + "01".repeat(47), feeRecipient, { value: 1n }),
      ).to.be.revertedWithCustomError(vaultHub, "InvalidPubkeysLength");
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.forceValidatorExit(stranger, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(stranger.address);
    });

    it("reverts if called for a disconnected vault", async () => {
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vaultAddress);
    });

    it("reverts if called for a healthy vault", async () => {
      await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "AlreadyHealthy")
        .withArgs(vaultAddress);
    });

    context("unhealthy vault", () => {
      beforeEach(async () => await makeVaultUnhealthy());

      it("initiates force validator withdrawal", async () => {
        await expect(vaultHub.forceValidatorExit(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: FEE }))
          .to.emit(vaultHub, "ForceValidatorExitTriggered")
          .withArgs(vaultAddress, SAMPLE_PUBKEY, feeRecipient);
      });

      it("initiates force validator withdrawal with multiple pubkeys", async () => {
        const numPubkeys = 3;
        const pubkeys = "0x" + "ab".repeat(numPubkeys * 48);

        await expect(
          vaultHub.forceValidatorExit(vaultAddress, pubkeys, feeRecipient, { value: FEE * BigInt(numPubkeys) }),
        )
          .to.emit(vaultHub, "ForceValidatorExitTriggered")
          .withArgs(vaultAddress, pubkeys, feeRecipient);
      });
    });

    // https://github.com/lidofinance/core/pull/933#discussion_r1954876831
    it("works for a synthetic example", async () => {
      const vaultCreationTx = (await vaultFactory
        .createVault(user, user)
        .then((tx) => tx.wait())) as ContractTransactionReceipt;

      const events = findEvents(vaultCreationTx, "VaultCreated");
      const demoVaultAddress = events[0].args.vault;

      const demoVault = await ethers.getContractAt("StakingVault__MockForVaultHub", demoVaultAddress, user);

      const valuation = ether("100");
      await demoVault.fund({ value: valuation });
      const cap = await steth.getSharesByPooledEth((valuation * (TOTAL_BASIS_POINTS - 20_00n)) / TOTAL_BASIS_POINTS);

      await registerVaultWithTier(demoVault, {
        shareLimit: cap,
        reserveRatioBP: 20_00n,
        rebalanceThresholdBP: 20_00n,
        treasuryFeeBP: 5_00n,
      });

      await vaultHub.connectVault(demoVaultAddress);
      await vaultHub.mintShares(demoVaultAddress, user, cap);

      expect((await vaultHub["vaultSocket(address)"](demoVaultAddress)).sharesMinted).to.equal(cap);

      // decrease valuation to trigger rebase
      const penalty = ether("1");
      await demoVault.mock__decreaseValuation(penalty);

      const preTotalPooledEther = await steth.getTotalPooledEther();
      const preTotalShares = await steth.getTotalShares();

      const rebase = await vaultHub.calculateVaultsRebase(
        [0n, valuation - penalty],
        preTotalShares,
        preTotalPooledEther,
        preTotalShares - cap,
        preTotalPooledEther - (cap * preTotalPooledEther) / preTotalShares,
        0n,
      );

      const totalMintedShares =
        (await vaultHub["vaultSocket(address)"](demoVaultAddress)).sharesMinted + rebase.treasuryFeeShares[1];
      const withReserve = (totalMintedShares * TOTAL_BASIS_POINTS) / (TOTAL_BASIS_POINTS - 20_00n);
      const predictedLockedEther = await steth.getPooledEthByShares(withReserve);

      expect(predictedLockedEther).to.equal(rebase.lockedEther[1]);

      await demoVault.report(valuation - penalty, valuation, rebase.lockedEther[1]);

      expect(await vaultHub.isVaultHealthy(demoVaultAddress)).to.be.false;

      await expect(vaultHub.forceValidatorExit(demoVaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: FEE }))
        .to.emit(vaultHub, "ForceValidatorExitTriggered")
        .withArgs(demoVaultAddress, SAMPLE_PUBKEY, feeRecipient);
    });
  });
});
