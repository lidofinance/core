import { expect } from "chai";
import { ethers } from "hardhat";

import {
  LazyOracle,
  Lido__MockForLazyOracle,
  LidoLocator,
  OperatorGrid__MockForLazyOracle,
  VaultHub__MockForLazyOracle,
} from "typechain-types";

import { randomAddress } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, ZERO_BYTES32 } from "test/suite";

describe("LazyOracle.sol", () => {
  let locator: LidoLocator;
  let vaultHub: VaultHub__MockForLazyOracle;
  let operatorGrid: OperatorGrid__MockForLazyOracle;
  let lido: Lido__MockForLazyOracle;
  let lazyOracle: LazyOracle;

  let originalState: string;

  before(async () => {
    vaultHub = await ethers.deployContract("VaultHub__MockForLazyOracle", []);
    operatorGrid = await ethers.deployContract("OperatorGrid__MockForLazyOracle", []);
    lido = await ethers.deployContract("Lido__MockForLazyOracle", []);

    locator = await deployLidoLocator({
      vaultHub: vaultHub,
      operatorGrid: operatorGrid,
      lido: lido,
    });

    lazyOracle = await ethers.deployContract("LazyOracle", [locator]);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("batchVaultsInfo", () => {
    it("returns the vault count", async () => {
      await vaultHub.mock__addVault(randomAddress());
      expect(await lazyOracle.vaultsCount()).to.equal(1n);

      await vaultHub.mock__addVault(randomAddress());
      expect(await lazyOracle.vaultsCount()).to.equal(2n);
    });

    async function createVault(): Promise<string> {
      const vault = await ethers.deployContract("Vault__MockForLazyOracle", []);
      return await vault.getAddress();
    }

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
        inOutDelta: {
          value: 5n,
          valueOnRefSlot: 6n,
          refSlot: 7n,
        },
      });
      const vaults = await lazyOracle.batchVaultsInfo(0n, 2n);

      expect(vaults.length).to.equal(1);

      const vaultInfo = vaults[0];
      expect(vaultInfo.vault).to.equal(vault1);
      expect(vaultInfo.vaultIndex).to.equal(1n);
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
  });
});
