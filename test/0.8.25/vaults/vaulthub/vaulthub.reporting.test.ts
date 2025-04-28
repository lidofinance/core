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

import { ether, findEvents, GENESIS_FORK_VERSION, getCurrentBlockTimestamp, impersonate } from "lib";
import { createVaultsReportTree, VaultReportItem } from "lib/protocol/helpers/vaults";

import { deployLidoDao, updateLidoLocatorImplementation } from "test/deploy";
import { Snapshot, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

const DEFAULT_TIER_SHARE_LIMIT = ether("1000");
const SHARE_LIMIT = ether("1");
const RESERVE_RATIO_BP = 10_00n;
const FORCED_REBALANCE_THRESHOLD_BP = 8_00n;
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
      forcedRebalanceThresholdBP?: bigint;
      treasuryFeeBP?: bigint;
    },
  ) {
    const vault = await createVault(factory);
    await vault.connect(user).fund({ value: CONNECT_DEPOSIT });
    await vault.connect(user).lock(CONNECT_DEPOSIT);

    const defaultTierId = await operatorGrid.DEFAULT_TIER_ID();
    await operatorGrid.connect(user).alterTier(defaultTierId, {
      shareLimit: options?.shareLimit ?? SHARE_LIMIT,
      reserveRatioBP: options?.reserveRatioBP ?? RESERVE_RATIO_BP,
      forcedRebalanceThresholdBP: options?.forcedRebalanceThresholdBP ?? FORCED_REBALANCE_THRESHOLD_BP,
      treasuryFeeBP: options?.treasuryFeeBP ?? TREASURY_FEE_BP,
    });
    await vaultHub.connect(user).connectVault(vault);

    return vault;
  }

  before(async () => {
    [deployer, user, whale] = await ethers.getSigners();

    predepositGuarantee = await ethers.deployContract("PredepositGuarantee_HarnessForFactory", [
      GENESIS_FORK_VERSION,
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
    const defaultTierParams = {
      shareLimit: DEFAULT_TIER_SHARE_LIMIT,
      reserveRatioBP: 2000n,
      forcedRebalanceThresholdBP: 1800n,
      treasuryFeeBP: 500n,
    };
    await operatorGrid.initialize(user, defaultTierParams);
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

    it("returns lastest report data correctly", async () => {
      const accountingAddress = await impersonate(await locator.accounting(), ether("1"));
      const reportTimestamp = await getCurrentBlockTimestamp();
      await expect(vaultHub.connect(accountingAddress).updateReportData(reportTimestamp, ethers.ZeroHash, "test_cid"))
        .to.not.reverted;

      const lastReportData = await vaultHub.latestReportData();
      expect(lastReportData.timestamp).to.equal(reportTimestamp);
      expect(lastReportData.treeRoot).to.equal(ethers.ZeroHash);
      expect(lastReportData.reportCid).to.equal("test_cid");
    });
  });

  context("updateVaultData", () => {
    it("reverts on invalid proof", async () => {
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

    it("accepts generated proof", async () => {
      const vaultsReport: VaultReportItem[] = [
        ["0xE312f1ed35c4dBd010A332118baAD69d45A0E302", 33000000000000000000n, 33000000000000000000n, 0n, 0n],
        [
          "0x652b70E0Ae932896035d553fEaA02f37Ab34f7DC",
          3100000000000000000n,
          3100000000000000000n,
          0n,
          510300000000000000n,
        ],
        [
          "0x20d34FD0482E3BdC944952D0277A306860be0014",
          2580000000000012501n,
          580000000000012501n,
          0n,
          1449900000000010001n,
        ],
        ["0x60B614c42d92d6c2E68AF7f4b741867648aBf9A4", 1000000000000000000n, 1000000000000000000n, 0n, 0n],
        [
          "0xE6BdAFAac1d91605903D203539faEd173793b7D7",
          1030000000000000000n,
          1030000000000000000n,
          0n,
          400000000000000000n,
        ],
        ["0x34ebc5780F36d3fD6F1e7b43CF8DB4a80dCE42De", 1000000000000000000n, 1000000000000000000n, 0n, 0n],
        [
          "0x3018F0cC632Aa3805a8a676613c62F55Ae4018C7",
          2000000000000000000n,
          2000000000000000000n,
          0n,
          100000000000000000n,
        ],
        [
          "0x40998324129B774fFc7cDA103A2d2cFd23EcB56e",
          1000000000000000000n,
          1000000000000000000n,
          0n,
          300000000000000000n,
        ],
        ["0x4ae099982712e2164fBb973554991111A418ab2B", 1000000000000000000n, 1000000000000000000n, 0n, 0n],
        ["0x59536AC6211C1deEf1EE37CDC11242A0bDc7db83", 1000000000000000000n, 1000000000000000000n, 0n, 0n],
      ];

      const tree = createVaultsReportTree(vaultsReport);
      expect(tree.root).to.equal("0x305228cb82b2385b40ebeb7f0b805e58c2e9942bd84183eb1d603b765af94ca1");
      const proof = tree.getProof(1);
      expect(proof).to.deep.equal([
        "0x3dfaa9117d824d40ae979f184ce0a9e60d7474912e7b53603e40b0b34cbba72f",
        "0x33c5d49ae39b473dc097b8987ab2f876542ad500209b96af5600da11289fe643",
        "0x5060c4e8e98281c0181273abcabb2e9e8f06fe6353e99f96606bb87635c9b090",
      ]);
    });

    it("updates vault data with precalculated proof", async () => {
      const accountingAddress = await impersonate(await locator.accounting(), ether("1"));
      await expect(
        vaultHub
          .connect(accountingAddress)
          .updateReportData(0, "0x305228cb82b2385b40ebeb7f0b805e58c2e9942bd84183eb1d603b765af94ca1", ""),
      ).to.not.reverted;

      await vaultHub.harness__connectVault(
        "0x20d34FD0482E3BdC944952D0277A306860be0014",
        99170000769726969624n,
        33000000000000000000n,
        0n,
        0n,
      );

      try {
        await vaultHub.updateVaultData(
          "0x20d34FD0482E3BdC944952D0277A306860be0014",
          2580000000000012501n,
          580000000000012501n,
          0n,
          1449900000000010001n,
          [
            "0x3ce25daf426ef04e5e0714b61a4a46c1ecb59922de95b73c45afe57779f1cc26",
            "0x33c5d49ae39b473dc097b8987ab2f876542ad500209b96af5600da11289fe643",
            "0x5060c4e8e98281c0181273abcabb2e9e8f06fe6353e99f96606bb87635c9b090",
          ],
        );
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (error: any) {
        // NOTE: Check that it's not InvalidProof but error while calling report() for fake StakingVault address
        expect(error.message).to.include("function call to a non-contract account");
      }
    });

    it("accepts proved values", async () => {
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
      totalValue: bigint,
      inOutDelta: bigint,
      treasuryFees: bigint,
      liabilityShares: bigint,
    ) {
      const vaultReport: VaultReportItem = [
        await vault.getAddress(),
        totalValue,
        inOutDelta,
        treasuryFees,
        liabilityShares,
      ];
      const tree = createVaultsReportTree([vaultReport]);
      const accountingAddress = await impersonate(await locator.accounting(), ether("100"));
      await vaultHub.connect(accountingAddress).updateReportData(await getCurrentBlockTimestamp(), tree.root, "");

      await vaultHub.updateVaultData(
        vault.getAddress(),
        totalValue,
        inOutDelta,
        treasuryFees,
        liabilityShares,
        tree.getProof(0),
      );
    }

    it("calculates cumulative vaults treasury fees", async () => {
      const vault = await createAndConnectVault(vaultFactory, {
        shareLimit: ether("100"), // just to bypass the share limit check
        reserveRatioBP: 50_00n, // 50%
        forcedRebalanceThresholdBP: 50_00n, // 50%
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
        forcedRebalanceThresholdBP: 50_00n, // 50%
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
