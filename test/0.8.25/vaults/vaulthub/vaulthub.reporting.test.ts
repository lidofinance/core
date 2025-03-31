import { expect } from "chai";
import { ContractTransactionReceipt, keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  DepositContract__MockForVaultHub,
  Lido,
  LidoLocator,
  PredepositGuarantee_HarnessForFactory,
  VaultFactory__MockForVaultHub,
  VaultHub,
} from "typechain-types";

import { ether, findEvents, impersonate } from "lib";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const TOTAL_BASIS_POINTS = 100_00n; // 100%
const VAULTS_CONNECTED_VAULTS_LIMIT = 5; // Low limit to test the overflow

describe("VaultHub.sol:hub", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let depositContract: DepositContract__MockForVaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let lido: Lido;
  let acl: ACL;

  let codehash: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(await user.getAddress(), await user.getAddress())
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    const vault = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
    return vault;
  }

  before(async () => {
    [deployer, user, whale] = await ethers.getSigners();

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
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

    const vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      await locator.lido(),
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    const proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
    await vaultHubAdmin.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.RESUME_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [
      await vaultHub.getAddress(),
      predepositGuarantee,
      depositContract,
    ]);

    vaultFactory = await ethers.deployContract("VaultFactory__MockForVaultHub", [await stakingVaultImpl.getAddress()]);
    const vault = await createVault(vaultFactory);

    codehash = keccak256(await ethers.provider.getCode(await vault.getAddress()));
    await vaultHub.connect(user).addVaultProxyCodehash(codehash);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("updateReportData", () => {
    it("reverts report update data call from non-Accounting contract", async () => {
      await expect(vaultHub.updateReportData(0, ethers.ZeroHash, "")).to.be.revertedWithCustomError(
        vaultHub,
        "NotAuthorized",
      );
    });

    it("accepts report data from Accounting contract", async () => {
      const accountingAddress = await impersonate(await locator.accounting(), ether("1"));
      await expect(vaultHub.connect(accountingAddress).updateReportData(0, ethers.ZeroHash, "")).to.not.reverted;
    });
  });

  context("updateVaultsData", () => {
    it("accepts prooved values", async () => {
      const ROOT = "0x4d7731e031705b521abbc5848458dc64ab85c2c3262be16f57bf5ea82a82178a";
      const PROOF = ["0xd129d34738564e7a38fa20b209e965b5fa6036268546a0d58bbe5806b2469c2e"];

      const accountingAddress = await impersonate(await locator.accounting(), ether("1"));
      await expect(vaultHub.connect(accountingAddress).updateReportData(0, ROOT, "")).to.not.reverted;

      await expect(
        vaultHub.updateVaultsData(
          "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
          99170000769726969624n,
          33000000000000000000n,
          0n,
          0n,
          PROOF,
        ),
      ).to.be.revertedWithCustomError(vaultHub, "NotConnectedToHub");
    });
  });
});
