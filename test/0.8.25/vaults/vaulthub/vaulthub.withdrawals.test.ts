import { expect } from "chai";
import { ContractTransactionReceipt, keccak256, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { DepositContract, StakingVault, StETH__HarnessForVaultHub, VaultHub } from "typechain-types";

import { impersonate } from "lib";
import { findEvents } from "lib/event";
import { ether } from "lib/units";

import { deployLidoLocator, deployWithdrawalsPreDeployedMock } from "test/deploy";
import { Snapshot } from "test/suite";

const SAMPLE_PUBKEY = "0x" + "01".repeat(48);

const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const FEE = 2n;

describe("VaultHub.sol:withdrawals", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;
  let feeRecipient: HardhatEthersSigner;
  let vaultHub: VaultHub;
  let vault: StakingVault;
  let steth: StETH__HarnessForVaultHub;
  let depositContract: DepositContract;

  let vaultAddress: string;
  let vaultHubAddress: string;

  let vaultHubSigner: HardhatEthersSigner;

  let originalState: string;

  before(async () => {
    [deployer, user, stranger, feeRecipient] = await ethers.getSigners();

    await deployWithdrawalsPreDeployedMock(FEE);

    const locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [user], { value: ether("100.0") });
    depositContract = await ethers.deployContract("DepositContract");

    const vaultHubImpl = await ethers.deployContract("Accounting", [locator, steth]);
    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const accounting = await ethers.getContractAt("Accounting", proxy);
    await accounting.initialize(deployer);

    vaultHub = await ethers.getContractAt("Accounting", proxy, user);
    vaultHubAddress = await vaultHub.getAddress();

    await accounting.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await accounting.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    const stakingVaultImpl = await ethers.deployContract("StakingVault", [
      await vaultHub.getAddress(),
      await depositContract.getAddress(),
    ]);

    const vaultFactory = await ethers.deployContract("VaultFactory__Mock", [await stakingVaultImpl.getAddress()]);

    const vaultCreationTx = (await vaultFactory
      .createVault(await user.getAddress(), await user.getAddress())
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    vault = await ethers.getContractAt("StakingVault", vaultCreatedEvent.args.vault, user);
    vaultAddress = await vault.getAddress();

    const codehash = keccak256(await ethers.provider.getCode(vaultAddress));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);

    await vaultHub
      .connect(user)
      .connectVault(vaultAddress, SHARE_LIMIT, RESERVE_RATIO_BP, RESERVE_RATIO_THRESHOLD_BP, TREASURY_FEE_BP);

    vaultHubSigner = await impersonate(vaultHubAddress, ether("100"));
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  // Simulate getting in the unhealthy state
  const makeVaultUnhealthy = async () => {
    await vault.fund({ value: ether("1") });
    await vaultHub.mintSharesBackedByVault(vaultAddress, user, ether("0.9"));
    await vault.connect(vaultHubSigner).report(ether("0.9"), ether("1"), ether("1.1")); // slashing
  };

  context("isVaultBalanced", () => {
    it("returns true if the vault is healthy", async () => {
      expect(await vaultHub.isVaultBalanced(vaultAddress)).to.be.true;
    });

    it("returns false if the vault is unhealthy", async () => {
      await makeVaultUnhealthy();
      expect(await vaultHub.isVaultBalanced(vaultAddress)).to.be.false;
    });
  });

  context("forceValidatorWithdrawal", () => {
    it("reverts if msg.value is 0", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 0n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("msg.value");
    });

    it("reverts if the vault is zero address", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(ZeroAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_vault");
    });

    it("reverts if zero pubkeys", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, "0x", feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_pubkeys");
    });

    it("reverts if zero refund recipient", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, ZeroAddress, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_refundRecepient");
    });

    it("reverts if vault is not connected to the hub", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(stranger, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(stranger.address);
    });

    it("reverts if called for a disconnected vault", async () => {
      await vaultHub.connect(user).disconnect(vaultAddress);

      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub")
        .withArgs(vaultAddress);
    });

    it("reverts if called for a healthy vault", async () => {
      await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
        .to.be.revertedWithCustomError(vaultHub, "AlreadyBalanced")
        .withArgs(vaultAddress, 0n, 0n);
    });

    context("unhealthy vault", () => {
      beforeEach(async () => await makeVaultUnhealthy());

      it("reverts if fees are insufficient", async () => {
        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: 1n }))
          .to.be.revertedWithCustomError(vault, "InsufficientValidatorWithdrawalFee")
          .withArgs(1n, FEE);
      });

      it("initiates force validator withdrawal", async () => {
        await expect(vaultHub.forceValidatorWithdrawal(vaultAddress, SAMPLE_PUBKEY, feeRecipient, { value: FEE }))
          .to.emit(vaultHub, "VaultForceWithdrawalTriggered")
          .withArgs(vaultAddress, SAMPLE_PUBKEY, feeRecipient);
      });

      it("initiates force validator withdrawal with multiple pubkeys", async () => {
        const numPubkeys = 3;
        const pubkeys = "0x" + "ab".repeat(numPubkeys * 48);

        await expect(
          vaultHub.forceValidatorWithdrawal(vaultAddress, pubkeys, feeRecipient, { value: FEE * BigInt(numPubkeys) }),
        )
          .to.emit(vaultHub, "VaultForceWithdrawalTriggered")
          .withArgs(vaultAddress, pubkeys, feeRecipient);
      });
    });
  });
});
