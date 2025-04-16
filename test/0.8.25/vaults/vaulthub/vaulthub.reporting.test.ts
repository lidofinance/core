import { expect } from "chai";
import { ContractTransactionReceipt, keccak256 } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  ACL,
  DepositContract__MockForVaultHub,
  Lido,
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  PredepositGuarantee_HarnessForFactory,
  StakingVault__MockForVaultHub,
  VaultFactory__MockForVaultHub,
  VaultHub__HarnessForReporting,
} from "typechain-types";

import { ether, findEvents, getCurrentBlockTimestamp, impersonate } from "lib";
import { createVaultsReportTree, VaultReportItem } from "lib/protocol/helpers/vaults";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const DEFAULT_GROUP_SHARE_LIMIT = ether("1000");
const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const RESERVE_RATIO_THRESHOLD_BP = 8_00n;
const TREASURY_FEE_BP = 5_00n;

const TOTAL_BASIS_POINTS = 100_00n; // 100%
const CONNECT_DEPOSIT = ether("1");

const TEST_ROOT = "0x4d7731e031705b521abbc5848458dc64ab85c2c3262be16f57bf5ea82a82178a";
const TEST_PROOF = ["0xd129d34738564e7a38fa20b209e965b5fa6036268546a0d58bbe5806b2469c2e"];

describe("VaultHub.sol:reporting", () => {
  let deployer: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let whale: HardhatEthersSigner;

  let predepositGuarantee: PredepositGuarantee_HarnessForFactory;
  let locator: LidoLocator;
  let vaultHub: VaultHub__HarnessForReporting;
  let depositContract: DepositContract__MockForVaultHub;
  let vaultFactory: VaultFactory__MockForVaultHub;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;
  let proxy: OssifiableProxy;
  let lido: Lido;
  let acl: ACL;

  let codehash: string;

  let originalState: string;

  async function createVault(factory: VaultFactory__MockForVaultHub) {
    const vaultCreationTx = (await factory
      .createVault(await user.getAddress(), await user.getAddress(), predepositGuarantee)
      .then((tx) => tx.wait())) as ContractTransactionReceipt;

    const events = findEvents(vaultCreationTx, "VaultCreated");
    const vaultCreatedEvent = events[0];

    const vault = await ethers.getContractAt("StakingVault__MockForVaultHub", vaultCreatedEvent.args.vault, user);
    return vault;
  }

  async function createAndConnectVault(
    factory: VaultFactory__MockForVaultHub,
    options?: {
      shareLimit?: bigint;
      reserveRatioBP?: bigint;
      rebalanceThresholdBP?: bigint;
      treasuryFeeBP?: bigint;
    },
  ) {
    const vault = await createVault(factory);
    await vault.connect(user).fund({ value: CONNECT_DEPOSIT });
    await vault.connect(user).lock(CONNECT_DEPOSIT);

    const DEFAULT_GROUP_ADDRESS = await operatorGrid.DEFAULT_GROUP_ADDRESS();
    await operatorGrid.connect(user).registerTiers(DEFAULT_GROUP_ADDRESS, [
      {
        shareLimit: options?.shareLimit ?? SHARE_LIMIT,
        reserveRatioBP: options?.reserveRatioBP ?? RESERVE_RATIO_BP,
        rebalanceThresholdBP: options?.rebalanceThresholdBP ?? RESERVE_RATIO_THRESHOLD_BP,
        treasuryFeeBP: options?.treasuryFeeBP ?? TREASURY_FEE_BP,
      },
    ]);
    await operatorGrid.connect(user).registerVault(vault);
    await vaultHub.connect(user).connectVault(vault);

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

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: deployer });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, deployer, new Uint8Array()], deployer);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, deployer);
    await operatorGrid.initialize(user, DEFAULT_GROUP_SHARE_LIMIT);
    await operatorGrid.connect(user).grantRole(await operatorGrid.REGISTRY_ROLE(), user);

    const vaultHubImpl = await ethers.deployContract("VaultHub__HarnessForReporting", [
      locator,
      await locator.lido(),
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, deployer, new Uint8Array()]);

    const vaultHubAdmin = await ethers.getContractAt("VaultHub", proxy);
    await vaultHubAdmin.initialize(deployer);

    vaultHub = await ethers.getContractAt("VaultHub__HarnessForReporting", proxy, user);
    await vaultHubAdmin.grantRole(await vaultHub.PAUSE_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.RESUME_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_MASTER_ROLE(), user);
    await vaultHubAdmin.grantRole(await vaultHub.VAULT_REGISTRY_ROLE(), user);

    await updateLidoLocatorImplementation(await locator.getAddress(), { vaultHub, predepositGuarantee, operatorGrid });

    const stakingVaultImpl = await ethers.deployContract("StakingVault__MockForVaultHub", [
      await vaultHub.getAddress(),
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

  context("updateVaultData", () => {
    it("accepts prooved values", async () => {
      const accountingAddress = await impersonate(await locator.accounting(), ether("1"));
      await expect(vaultHub.connect(accountingAddress).updateReportData(0, TEST_ROOT, "")).to.not.reverted;
      await vaultHub.harness__connectVault(
        "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
        99170000769726969624n,
        33000000000000000000n,
        0n,
        0n,
      );

      await expect(
        vaultHub.updateVaultData(
          "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
          99170000769726969624n,
          33000000000000000001n,
          0n,
          0n,
          TEST_PROOF,
        ),
      ).to.be.revertedWithCustomError(vaultHub, "InvalidProof");
    });

    it("accepts prooved values", async () => {
      const accountingAddress = await impersonate(await locator.accounting(), ether("1"));
      await expect(vaultHub.connect(accountingAddress).updateReportData(0, TEST_ROOT, "")).to.not.reverted;

      await vaultHub.harness__connectVault(
        "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
        99170000769726969624n,
        33000000000000000000n,
        0n,
        0n,
      );

      await expect(
        vaultHub.updateVaultData(
          "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
          99170000769726969624n,
          33000000000000000000n,
          0n,
          0n,
          TEST_PROOF,
        ),
      ).to.be.reverted;
    });

    it("calculates merkle tree the same way as off-chain implementation", async () => {
      const values: VaultReportItem[] = [
        ["0xc1F9c4a809cbc6Cb2cA60bCa09cE9A55bD5337Db", 2500000000000000000n, 2500000000000000000n, 0n, 1n],
        ["0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60", 99170000769726969624n, 33000000000000000000n, 0n, 0n],
      ];

      const tree = createVaultsReportTree(values);
      expect(tree.root).to.equal(TEST_ROOT);
      const proof = tree.getProof(1);
      expect(proof).to.deep.equal(TEST_PROOF);
    });

    async function updateVaultReportHelper(
      vault: StakingVault__MockForVaultHub,
      valuation: bigint,
      inOutDelta: bigint,
      treasuryFees: bigint,
      sharesMinted: bigint,
    ) {
      const vaultReport: VaultReportItem = [
        await vault.getAddress(),
        valuation,
        inOutDelta,
        treasuryFees,
        sharesMinted,
      ];
      const tree = createVaultsReportTree([vaultReport]);
      const accountingAddress = await impersonate(await locator.accounting(), ether("100"));
      await vaultHub.connect(accountingAddress).updateReportData(await getCurrentBlockTimestamp(), tree.root, "");

      await vaultHub.updateVaultData(
        vault.getAddress(),
        valuation,
        inOutDelta,
        treasuryFees,
        sharesMinted,
        tree.getProof(0),
      );
    }

    it("calculates cumulative vaults treasury fees", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      await updateVaultReportHelper(vault, 99170000769726969624n, 33000000000000000000n, 100n, 0n);

      const vaultSocket = await vaultHub["vaultSocket(uint256)"](0n);
      expect(vaultSocket.feeSharesCharged).to.equal(100n);

      await updateVaultReportHelper(vault, 99170000769726969624n, 33000000000000000000n, 101n, 0n);

      const vaultSocket2 = await vaultHub["vaultSocket(uint256)"](0n);
      expect(vaultSocket2.feeSharesCharged).to.equal(101n);
    });

    it("rejects incorrectly reported cumulative vaults treasury fees", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        rebalanceThresholdBP: 50_00n, // 50%
      });

      await updateVaultReportHelper(vault, 99170000769726969624n, 33000000000000000000n, 100n, 0n);

      const vaultSocket = await vaultHub["vaultSocket(uint256)"](0n);
      expect(vaultSocket.feeSharesCharged).to.equal(100n);

      await expect(updateVaultReportHelper(vault, 99170000769726969624n, 33000000000000000000n, 99n, 0n))
        .to.be.revertedWithCustomError(vaultHub, "InvalidFees")
        .withArgs(vault.getAddress(), 99n, 100n);
    });
  });
});
