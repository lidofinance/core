import { expect } from "chai";
import { ethers } from "hardhat";

import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LazyOracle,
  Lido__MockForLazyOracle,
  LidoLocator,
  OperatorGrid__MockForLazyOracle,
  VaultHub,
  VaultHub__MockForLazyOracle,
} from "typechain-types";

import { advanceChainTime, ether, getCurrentBlockTimestamp, impersonate, randomAddress } from "lib";
import { createVaultsReportTree, VaultReportItem } from "lib/protocol/helpers/vaults";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, ZERO_BYTES32 } from "test/suite";

const VAULT_TOTAL_VALUE = ether("100");

const record: Readonly<VaultHub.VaultRecordStruct> = {
  report: {
    totalValue: VAULT_TOTAL_VALUE,
    inOutDelta: VAULT_TOTAL_VALUE,
    timestamp: 2122n,
  },
  liabilityShares: 0n,
  locked: VAULT_TOTAL_VALUE,
  inOutDelta: [
    {
      value: VAULT_TOTAL_VALUE,
      valueOnRefSlot: VAULT_TOTAL_VALUE,
      refSlot: 1n,
    },
    {
      value: 0n,
      valueOnRefSlot: 0n,
      refSlot: 0n,
    },
  ],
  minimalReserve: 0n,
  redemptionShares: 0n,
  cumulativeLidoFees: 0n,
  settledLidoFees: 0n,
};

describe("LazyOracle.sol", () => {
  let deployer: SignerWithAddress;
  let locator: LidoLocator;
  let vaultHub: VaultHub__MockForLazyOracle;
  let operatorGrid: OperatorGrid__MockForLazyOracle;
  let lido: Lido__MockForLazyOracle;
  let lazyOracle: LazyOracle;

  let originalState: string;

  const QUARANTINE_PERIOD = 259200n;

  before(async () => {
    [deployer] = await ethers.getSigners();
    vaultHub = await ethers.deployContract("VaultHub__MockForLazyOracle", []);
    operatorGrid = await ethers.deployContract("OperatorGrid__MockForLazyOracle", []);
    lido = await ethers.deployContract("Lido__MockForLazyOracle", []);

    locator = await deployLidoLocator({
      vaultHub: vaultHub,
      operatorGrid: operatorGrid,
      lido: lido,
    });
    const lazyOracleImpl = await ethers.deployContract("LazyOracle", [locator]);

    const proxy = await ethers.deployContract(
      "OssifiableProxy",
      [lazyOracleImpl, deployer, new Uint8Array()],
      deployer,
    );
    lazyOracle = await ethers.getContractAt("LazyOracle", proxy);

    await lazyOracle.initialize(deployer.address, QUARANTINE_PERIOD, 350n);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  async function createVault(): Promise<string> {
    const vault = await ethers.deployContract("Vault__MockForLazyOracle", []);
    return await vault.getAddress();
  }

  context("batchVaultsInfo", () => {
    it("returns the vault count", async () => {
      await vaultHub.mock__addVault(randomAddress());
      expect(await lazyOracle.vaultsCount()).to.equal(1n);

      await vaultHub.mock__addVault(randomAddress());
      expect(await lazyOracle.vaultsCount()).to.equal(2n);
    });

    it("returns the vault info", async () => {
      const vault1 = await createVault();
      await vaultHub.mock__addVault(vault1);

      await vaultHub.mock__setVaultConnection(vault1, {
        owner: randomAddress(),
        shareLimit: 1000n,
        vaultIndex: 1,
        pendingDisconnect: false,
        reserveRatioBP: 10000,
        forcedRebalanceThresholdBP: 10000,
        infraFeeBP: 10000,
        liquidityFeeBP: 10000,
        reservationFeeBP: 10000,
        isBeaconDepositsManuallyPaused: false,
      });

      await vaultHub.mock__setVaultRecord(vault1, {
        report: {
          totalValue: 1000000000000000000n,
          inOutDelta: 2000000000000000000n,
          timestamp: 1000000000n,
        },
        locked: 3n,
        liabilityShares: 4n,
        inOutDelta: [
          {
            value: 5n,
            valueOnRefSlot: 6n,
            refSlot: 7n,
          },
          {
            value: 0n,
            valueOnRefSlot: 0n,
            refSlot: 0n,
          },
        ],
        minimalReserve: 0n,
        redemptionShares: 0n,
        cumulativeLidoFees: 0n,
        settledLidoFees: 0n,
      });

      const vaults = await lazyOracle.batchVaultsInfo(0n, 2n);

      expect(vaults.length).to.equal(1);

      const vaultInfo = vaults[0];
      expect(vaultInfo.vault).to.equal(vault1);
      expect(vaultInfo.balance).to.equal(0n);
      expect(vaultInfo.inOutDelta).to.equal(5n);
      expect(vaultInfo.withdrawalCredentials).to.equal(ZERO_BYTES32);
      expect(vaultInfo.liabilityShares).to.equal(4n);
      expect(vaultInfo.mintableStETH).to.equal(0n);
      expect(vaultInfo.shareLimit).to.equal(1000n);
      expect(vaultInfo.reserveRatioBP).to.equal(10000);
      expect(vaultInfo.forcedRebalanceThresholdBP).to.equal(10000);
      expect(vaultInfo.infraFeeBP).to.equal(10000);
      expect(vaultInfo.liquidityFeeBP).to.equal(10000);
      expect(vaultInfo.reservationFeeBP).to.equal(10000);
      expect(vaultInfo.pendingDisconnect).to.equal(false);
    });

    it("returns the vault info with pagination", async () => {
      const vault1 = await createVault();
      await vaultHub.mock__addVault(vault1);
      const vault2 = await createVault();
      await vaultHub.mock__addVault(vault2);
      const vault3 = await createVault();
      await vaultHub.mock__addVault(vault3);

      const vaults1 = await lazyOracle.batchVaultsInfo(0n, 1n);
      expect(vaults1.length).to.equal(1);
      expect(vaults1[0].vault).to.equal(vault1);

      const vaults2 = await lazyOracle.batchVaultsInfo(1n, 1n);
      expect(vaults2.length).to.equal(1);
      expect(vaults2[0].vault).to.equal(vault2);

      const vaults3 = await lazyOracle.batchVaultsInfo(0n, 4n);
      expect(vaults3.length).to.equal(3);
      expect(vaults3[0].vault).to.equal(vault1);
      expect(vaults3[1].vault).to.equal(vault2);
      expect(vaults3[2].vault).to.equal(vault3);

      const vaults4 = await lazyOracle.batchVaultsInfo(1n, 3n);
      expect(vaults4.length).to.equal(2);
      expect(vaults4[0].vault).to.equal(vault2);
      expect(vaults4[1].vault).to.equal(vault3);

      const vaults5 = await lazyOracle.batchVaultsInfo(0n, 0n);
      expect(vaults5.length).to.equal(0);

      const vaults6 = await lazyOracle.batchVaultsInfo(3n, 1n);
      expect(vaults6.length).to.equal(0);
    });

    it("returns the empty vault info for exceeding offset", async () => {
      const vault = await createVault();
      await vaultHub.mock__addVault(vault);
      const vaults = await lazyOracle.batchVaultsInfo(1n, 1n);
      expect(vaults.length).to.equal(0);
    });
  });

  context("getter functions", () => {
    it("return latest report data", async () => {
      const reportData = await lazyOracle.latestReportData();
      expect(reportData.timestamp).to.equal(0n);
      expect(reportData.treeRoot).to.equal(ZERO_BYTES32);
      expect(reportData.reportCid).to.equal("");
    });

    it("return latest report timestamp", async () => {
      const timestamp = await lazyOracle.latestReportTimestamp();
      expect(timestamp).to.equal(0n);
    });

    it("return quarantine period", async () => {
      const quarantinePeriod = await lazyOracle.quarantinePeriod();
      expect(quarantinePeriod).to.equal(259200n);
    });

    it("return max reward ratio", async () => {
      const maxRewardRatio = await lazyOracle.maxRewardRatioBP();
      expect(maxRewardRatio).to.equal(350n);
    });

    it("return quarantine info", async () => {
      const quarantineInfo = await lazyOracle.vaultQuarantine(randomAddress());
      expect(quarantineInfo.isActive).to.equal(false);
      expect(quarantineInfo.pendingTotalValueIncrease).to.equal(0n);
      expect(quarantineInfo.startTimestamp).to.equal(0n);
    });
  });

  context("sanity params", () => {
    it("update quarantine period", async () => {
      await expect(lazyOracle.updateSanityParams(250000n, 1000n))
        .to.be.revertedWithCustomError(lazyOracle, "AccessControlUnauthorizedAccount")
        .withArgs(deployer.address, await lazyOracle.UPDATE_SANITY_PARAMS_ROLE());

      await lazyOracle.grantRole(await lazyOracle.UPDATE_SANITY_PARAMS_ROLE(), deployer.address);
      await expect(lazyOracle.updateSanityParams(250000n, 1000n)).to.not.reverted;
      expect(await lazyOracle.quarantinePeriod()).to.equal(250000n);
      expect(await lazyOracle.maxRewardRatioBP()).to.equal(1000n);
    });
  });

  context("updateReportData", () => {
    it("reverts report update data call from non-Accounting contract", async () => {
      await expect(lazyOracle.updateReportData(0, 0n, ethers.ZeroHash, "")).to.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });

    it("accepts report data from Accounting contract", async () => {
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("1"));
      await expect(lazyOracle.connect(accountingAddress).updateReportData(0, 0n, ethers.ZeroHash, "")).to.not.reverted;
    });

    it("returns lastest report data correctly", async () => {
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("1"));
      const reportTimestamp = await getCurrentBlockTimestamp();
      const refSlot = 42n;
      await expect(
        lazyOracle.connect(accountingAddress).updateReportData(reportTimestamp, refSlot, ethers.ZeroHash, "test_cid"),
      ).to.not.reverted;

      const lastReportData = await lazyOracle.latestReportData();
      expect(lastReportData.timestamp).to.equal(reportTimestamp);
      expect(lastReportData.refSlot).to.equal(refSlot);
      expect(lastReportData.treeRoot).to.equal(ethers.ZeroHash);
      expect(lastReportData.reportCid).to.equal("test_cid");
    });
  });

  context("updateVaultData", () => {
    const TEST_PROOF = ["0xd129d34738564e7a38fa20b209e965b5fa6036268546a0d58bbe5806b2469c2e"];
    const TEST_ROOT = "0x4d7731e031705b521abbc5848458dc64ab85c2c3262be16f57bf5ea82a82178a";

    it("reverts on invalid proof", async () => {
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("1"));
      await expect(lazyOracle.connect(accountingAddress).updateReportData(0, 0n, ethers.ZeroHash, "")).to.not.reverted;
      await vaultHub.mock__addVault("0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60");

      await expect(
        lazyOracle.updateVaultData(
          "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
          99170000769726969624n,
          10000000n,
          0n,
          0n,
          TEST_PROOF,
        ),
      ).to.be.revertedWithCustomError(lazyOracle, "InvalidProof");
    });

    it("accepts generated proof", async () => {
      const vaultsReport: VaultReportItem[] = [
        {
          vault: "0xE312f1ed35c4dBd010A332118baAD69d45A0E302",
          totalValue: 33000000000000000000n,
          cumulativeLidoFees: 0n,
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
        {
          vault: "0x652b70E0Ae932896035d553fEaA02f37Ab34f7DC",
          totalValue: 3100000000000000000n,
          cumulativeLidoFees: 0n,
          liabilityShares: 0n,
          slashingReserve: 510300000000000000n,
        },
        {
          vault: "0x20d34FD0482E3BdC944952D0277A306860be0014",
          totalValue: 2580000000000012501n,
          cumulativeLidoFees: 580000000000012501n,
          liabilityShares: 0n,
          slashingReserve: 1449900000000010001n,
        },
        {
          vault: "0x60B614c42d92d6c2E68AF7f4b741867648aBf9A4",
          totalValue: 1000000000000000000n,
          cumulativeLidoFees: 1000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
        {
          vault: "0xE6BdAFAac1d91605903D203539faEd173793b7D7",
          totalValue: 1030000000000000000n,
          cumulativeLidoFees: 1030000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 400000000000000000n,
        },
        {
          vault: "0x34ebc5780F36d3fD6F1e7b43CF8DB4a80dCE42De",
          totalValue: 1000000000000000000n,
          cumulativeLidoFees: 1000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
        {
          vault: "0x3018F0cC632Aa3805a8a676613c62F55Ae4018C7",
          totalValue: 2000000000000000000n,
          cumulativeLidoFees: 2000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 100000000000000000n,
        },
        {
          vault: "0x40998324129B774fFc7cDA103A2d2cFd23EcB56e",
          totalValue: 1000000000000000000n,
          cumulativeLidoFees: 1000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 300000000000000000n,
        },
        {
          vault: "0x4ae099982712e2164fBb973554991111A418ab2B",
          totalValue: 1000000000000000000n,
          cumulativeLidoFees: 1000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
        {
          vault: "0x59536AC6211C1deEf1EE37CDC11242A0bDc7db83",
          totalValue: 1000000000000000000n,
          cumulativeLidoFees: 1000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
      ];

      const tree = createVaultsReportTree(vaultsReport);
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("100"));

      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = 42n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp, refSlot, tree.root, "");

      for (let index = 0; index < vaultsReport.length; index++) {
        const vaultReport = vaultsReport[index];

        await lazyOracle.updateVaultData(
          vaultReport.vault,
          vaultReport.totalValue,
          vaultReport.cumulativeLidoFees,
          vaultReport.liabilityShares,
          vaultReport.slashingReserve,
          tree.getProof(index),
        );
        expect(await vaultHub.mock__lastReportedVault()).to.equal(vaultReport.vault);
        expect(await vaultHub.mock__lastReported_timestamp()).to.equal(timestamp);
        expect(await vaultHub.mock__lastReported_cumulativeLidoFees()).to.equal(vaultReport.cumulativeLidoFees);
        expect(await vaultHub.mock__lastReported_liabilityShares()).to.equal(vaultReport.liabilityShares);
        expect(await vaultHub.mock__lastReported_slashingReserve()).to.equal(vaultReport.slashingReserve);
      }

      expect(tree.root).to.equal("0x14a968ec37647b2086e05d9c19762eb528736cc3618fb99101ec4adb27f63c26");
      const proof = tree.getProof(1);
      expect(proof).to.deep.equal([
        "0x05d2e4cb42d7a2fc8347e6f6157e039b62f6380d2fcf545520db8029e6b541cc",
        "0x3027050bbe118641c9dab8adb053cc2071b29f78f9edfbc678c4f525f2fbe1de",
        "0x1b0d29f502033ef4f86abb47a8efa9f0d26dd92de90cd4e721282d60d85d0e9b",
        "0x033aa9c0ad17d6c5e220abc83c91fb35f89ad0bc3fff9ca80b0160d813a7394b",
      ]);
    });

    it("calculates merkle tree the same way as off-chain implementation", async () => {
      const values: VaultReportItem[] = [
        {
          vault: "0xc1F9c4a809cbc6Cb2cA60bCa09cE9A55bD5337Db",
          totalValue: 2500000000000000000n,
          cumulativeLidoFees: 2500000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 1n,
        },
        {
          vault: "0xEcB7C8D2BaF7270F90066B4cd8286e2CA1154F60",
          totalValue: 99170000769726969624n,
          cumulativeLidoFees: 33000000000000000000n,
          liabilityShares: 0n,
          slashingReserve: 0n,
        },
      ];

      const tree = createVaultsReportTree(values);
      expect(tree.root).to.equal(TEST_ROOT);
      const proof = tree.getProof(1);
      expect(proof).to.deep.equal(TEST_PROOF);
    });
  });

  context("handleSanityChecks", () => {
    it("allows some percentage of the EL and CL rewards handling", async () => {
      const vault = await createVault();
      const maxRewardRatio = await lazyOracle.maxRewardRatioBP();
      const maxRewardValue = (maxRewardRatio * VAULT_TOTAL_VALUE) / 10000n;
      const vaultReport: VaultReportItem = {
        vault,
        totalValue: VAULT_TOTAL_VALUE + maxRewardValue,
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree = createVaultsReportTree([vaultReport]);
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("100"));
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = 42n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp, refSlot, tree.root, "");

      await vaultHub.mock__addVault(vault);
      await vaultHub.mock__setVaultRecord(vault, record);

      await lazyOracle.updateVaultData(
        vaultReport.vault,
        vaultReport.totalValue,
        vaultReport.cumulativeLidoFees,
        vaultReport.liabilityShares,
        vaultReport.slashingReserve,
        tree.getProof(0),
      );
      expect(await vaultHub.mock__lastReported_totalValue()).to.equal(VAULT_TOTAL_VALUE + maxRewardValue);

      const quarantineInfo = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo.isActive).to.equal(false);

      // Second report exceeds the max reward value by 1 wei - should be quarantined
      const vaultReport2: VaultReportItem = {
        vault,
        totalValue: VAULT_TOTAL_VALUE + maxRewardValue + 1n,
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree2 = createVaultsReportTree([vaultReport2]);
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp, refSlot, tree2.root, "");

      await vaultHub.mock__setVaultRecord(vault, record);

      await lazyOracle.updateVaultData(
        vaultReport2.vault,
        vaultReport2.totalValue,
        vaultReport2.cumulativeLidoFees,
        vaultReport2.liabilityShares,
        vaultReport2.slashingReserve,
        tree2.getProof(0),
      );

      expect(await vaultHub.mock__lastReported_totalValue()).to.equal(VAULT_TOTAL_VALUE);

      const quarantineInfo2 = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo2.isActive).to.equal(true);
      expect(quarantineInfo2.pendingTotalValueIncrease).to.equal(maxRewardValue + 1n);
    });

    it("limit the vault total value", async () => {
      const vault = await createVault();
      const vaultReport: VaultReportItem = {
        vault,
        totalValue: ether("250"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree = createVaultsReportTree([vaultReport]);
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("100"));
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = 42n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp, refSlot, tree.root, "");

      await vaultHub.mock__addVault(vault);
      await vaultHub.mock__setVaultRecord(vault, record);

      await expect(
        lazyOracle.updateVaultData(
          vaultReport.vault,
          vaultReport.totalValue,
          vaultReport.cumulativeLidoFees,
          vaultReport.liabilityShares,
          vaultReport.slashingReserve,
          tree.getProof(0),
        ),
      )
        .to.emit(lazyOracle, "QuarantineActivated")
        .withArgs(vault, ether("150"));
      expect(await vaultHub.mock__lastReported_totalValue()).to.equal(ether("100"));

      const quarantineInfo = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo.isActive).to.equal(true);
      expect(quarantineInfo.pendingTotalValueIncrease).to.equal(ether("150"));
      expect(quarantineInfo.startTimestamp).to.equal(timestamp);
      expect(quarantineInfo.endTimestamp).to.equal(timestamp + QUARANTINE_PERIOD);

      // Second report - in 24 hours we add more funds to the vault
      const vaultReport2: VaultReportItem = {
        vault,
        totalValue: ether("340"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree2 = createVaultsReportTree([vaultReport2]);
      await advanceChainTime(60n * 60n * 23n);
      const timestamp2 = await getCurrentBlockTimestamp();
      const refSlot2 = 43n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp2, refSlot2, tree2.root, "");

      await lazyOracle.updateVaultData(
        vaultReport2.vault,
        vaultReport2.totalValue,
        vaultReport2.cumulativeLidoFees,
        vaultReport2.liabilityShares,
        vaultReport2.slashingReserve,
        tree2.getProof(0),
      );
      expect(await vaultHub.mock__lastReported_totalValue()).to.equal(ether("100"));

      const quarantineInfo2 = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo2.isActive).to.equal(true);
      expect(quarantineInfo2.pendingTotalValueIncrease).to.equal(ether("150"));
      expect(quarantineInfo2.startTimestamp).to.equal(timestamp);
      expect(quarantineInfo2.endTimestamp).to.equal(timestamp + QUARANTINE_PERIOD);

      // Third report - in 3 days -  we keep the vault at the same level
      const vaultReport3: VaultReportItem = {
        vault,
        totalValue: ether("340"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree3 = createVaultsReportTree([vaultReport3]);
      await advanceChainTime(60n * 60n * 23n * 5n);
      const timestamp3 = await getCurrentBlockTimestamp();
      const refSlot3 = 44n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp3, refSlot3, tree3.root, "");

      await expect(
        lazyOracle.updateVaultData(
          vaultReport3.vault,
          vaultReport3.totalValue,
          vaultReport3.cumulativeLidoFees,
          vaultReport3.liabilityShares,
          vaultReport3.slashingReserve,
          tree3.getProof(0),
        ),
      )
        .to.emit(lazyOracle, "QuarantineActivated")
        .withArgs(vault, ether("90"));

      const quarantineInfo3 = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo3.isActive).to.equal(true);
      expect(quarantineInfo3.pendingTotalValueIncrease).to.equal(ether("90"));
      expect(quarantineInfo3.startTimestamp).to.equal(timestamp3);
      expect(quarantineInfo3.endTimestamp).to.equal(timestamp3 + QUARANTINE_PERIOD);

      // Fourth report - in 4 days -  we keep the vault at the same level
      const vaultReport4: VaultReportItem = {
        vault,
        totalValue: ether("340"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree4 = createVaultsReportTree([vaultReport4]);
      await advanceChainTime(60n * 60n * 23n * 4n);
      const timestamp4 = await getCurrentBlockTimestamp();
      const refSlot4 = 45n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp4, refSlot4, tree4.root, "");

      await expect(
        lazyOracle.updateVaultData(
          vaultReport4.vault,
          vaultReport4.totalValue,
          vaultReport4.cumulativeLidoFees,
          vaultReport4.liabilityShares,
          vaultReport4.slashingReserve,
          tree4.getProof(0),
        ),
      )
        .to.emit(lazyOracle, "QuarantineReleased")
        .withArgs(vault, ether("90"));

      const quarantineInfo4 = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo4.isActive).to.equal(false);
      expect(quarantineInfo4.pendingTotalValueIncrease).to.equal(0n);
      expect(quarantineInfo4.startTimestamp).to.equal(0n);
      expect(quarantineInfo4.endTimestamp).to.equal(0n);
    });

    it("inactive quarantine expired", async () => {
      const vault = await createVault();
      const vaultReport: VaultReportItem = {
        vault,
        totalValue: ether("250"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree = createVaultsReportTree([vaultReport]);
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("100"));
      const timestamp = await getCurrentBlockTimestamp();
      const refSlot = 42n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp, refSlot, tree.root, "");

      await vaultHub.mock__addVault(vault);
      await vaultHub.mock__setVaultRecord(vault, record);

      await expect(
        lazyOracle.updateVaultData(
          vaultReport.vault,
          vaultReport.totalValue,
          vaultReport.cumulativeLidoFees,
          vaultReport.liabilityShares,
          vaultReport.slashingReserve,
          tree.getProof(0),
        ),
      )
        .to.emit(lazyOracle, "QuarantineActivated")
        .withArgs(vault, ether("150"));
      await expect(await vaultHub.mock__lastReported_totalValue()).to.equal(ether("100"));

      const quarantineInfo = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo.isActive).to.equal(true);
      expect(quarantineInfo.pendingTotalValueIncrease).to.equal(ether("150"));
      expect(quarantineInfo.startTimestamp).to.equal(timestamp);
      expect(quarantineInfo.endTimestamp).to.equal(timestamp + QUARANTINE_PERIOD);

      // Second report - in 5 days - bring report without exceeding saneLimitTotalValue
      const vaultReport2: VaultReportItem = {
        vault,
        totalValue: ether("101"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree3 = createVaultsReportTree([vaultReport2]);
      await advanceChainTime(60n * 60n * 24n * 5n);
      const timestamp3 = await getCurrentBlockTimestamp();
      const refSlot3 = 43n;
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp3, refSlot3, tree3.root, "");

      await expect(
        lazyOracle.updateVaultData(
          vaultReport2.vault,
          vaultReport2.totalValue,
          vaultReport2.cumulativeLidoFees,
          vaultReport2.liabilityShares,
          vaultReport2.slashingReserve,
          tree3.getProof(0),
        ),
      )
        .to.emit(lazyOracle, "QuarantineReleased")
        .withArgs(vault, 0n);

      const quarantineInfo2 = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo2.isActive).to.equal(false);
      expect(quarantineInfo2.pendingTotalValueIncrease).to.equal(0n);
      expect(quarantineInfo2.startTimestamp).to.equal(0n);
      expect(quarantineInfo2.endTimestamp).to.equal(0n);
    });
  });

  context("removeVaultQuarantine", () => {
    it("only vaultHub can remove quarantine", async () => {
      await expect(lazyOracle.removeVaultQuarantine(randomAddress())).to.be.revertedWithCustomError(
        lazyOracle,
        "NotAuthorized",
      );
    });

    it("remove quarantine", async () => {
      const vault = await createVault();
      const vaultReport: VaultReportItem = {
        vault,
        totalValue: ether("250"),
        cumulativeLidoFees: 0n,
        liabilityShares: 0n,
        slashingReserve: 0n,
      };

      const tree = createVaultsReportTree([vaultReport]);
      const accountingAddress = await impersonate(await locator.accountingOracle(), ether("100"));
      const timestamp = await getCurrentBlockTimestamp();
      await lazyOracle.connect(accountingAddress).updateReportData(timestamp, 42n, tree.root, "");

      await vaultHub.mock__addVault(vault);
      await vaultHub.mock__setVaultRecord(vault, record);

      await lazyOracle.updateVaultData(
        vaultReport.vault,
        vaultReport.totalValue,
        vaultReport.cumulativeLidoFees,
        vaultReport.liabilityShares,
        vaultReport.slashingReserve,
        tree.getProof(0),
      );

      let quarantineInfo = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo.isActive).to.equal(true);
      expect(quarantineInfo.pendingTotalValueIncrease).to.equal(ether("150"));
      expect(quarantineInfo.startTimestamp).to.equal(timestamp);
      expect(quarantineInfo.endTimestamp).to.equal(timestamp + QUARANTINE_PERIOD);

      const vaultHubAddress = await impersonate(await vaultHub.getAddress(), ether("100"));
      await expect(lazyOracle.connect(vaultHubAddress).removeVaultQuarantine(vault))
        .to.emit(lazyOracle, "QuarantineRemoved")
        .withArgs(vault);

      quarantineInfo = await lazyOracle.vaultQuarantine(vault);
      expect(quarantineInfo.isActive).to.equal(false);
      expect(quarantineInfo.pendingTotalValueIncrease).to.equal(0n);
      expect(quarantineInfo.startTimestamp).to.equal(0n);
      expect(quarantineInfo.endTimestamp).to.equal(0n);
    });
  });
});
