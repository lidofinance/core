import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { LidoLocator, OssifiableProxy, StETH__Harness, VaultHub } from "typechain-types";

import { ether, randomAddress } from "lib";
import { TOTAL_BASIS_POINTS } from "lib/constants";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

describe("VaultHub.sol:initialization", () => {
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let proxy: OssifiableProxy;
  let vaultHubImpl: VaultHub;
  let steth: StETH__Harness;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let consensusContract: string;

  let originalState: string;

  before(async () => {
    [admin, user, holder, stranger] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__Harness", [holder], { value: ether("10.0") });
    locator = await deployLidoLocator({ lido: steth });
    consensusContract = randomAddress();

    // VaultHub
    vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      await locator.lido(),
      consensusContract,
      VAULTS_MAX_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, admin, new Uint8Array()], admin);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialization", () => {
    it("reverts on impl initialization", async () => {
      await expect(vaultHubImpl.initialize(stranger)).to.be.revertedWithCustomError(
        vaultHubImpl,
        "InvalidInitialization",
      );
    });

    it("reverts on `_admin` address is zero", async () => {
      await expect(vaultHub.initialize(ZeroAddress)).to.be.revertedWithCustomError(vaultHub, "ZeroAddress");
    });

    it("initialization happy path", async () => {
      const tx = await vaultHub.initialize(admin);

      expect(await vaultHub.vaultsCount()).to.eq(0);

      await expect(tx).to.be.emit(vaultHub, "Initialized").withArgs(1);
    });
  });

  context("constructor", () => {
    it("ossifies the implementation", async () => {
      expect(await vaultHubImpl.isPaused()).to.be.true;
      await expect(vaultHubImpl.initialize(stranger)).to.be.revertedWithCustomError(
        vaultHubImpl,
        "InvalidInitialization",
      );
    });

    it("reverts on `_locator` is zero", async () => {
      await expect(
        ethers.deployContract("VaultHub", [ZeroAddress, await locator.lido(), consensusContract, 0n]),
      ).to.be.revertedWithCustomError(vaultHubImpl, "ZeroAddress");
    });

    it("reverts on `_lido` is zero", async () => {
      await expect(
        ethers.deployContract("VaultHub", [locator, ZeroAddress, consensusContract, 0n]),
      ).to.be.revertedWithCustomError(vaultHubImpl, "ZeroAddress");
    });

    it("reverts on `_consensusContract` is zero", async () => {
      await expect(
        ethers.deployContract("VaultHub", [locator, await locator.lido(), ZeroAddress, 0n]),
      ).to.be.revertedWithCustomError(vaultHubImpl, "ZeroAddress");
    });

    it("reverts on `_maxRelativeShareLimitBP` is zero", async () => {
      await expect(
        ethers.deployContract("VaultHub", [locator, await locator.lido(), consensusContract, 0n]),
      ).to.be.revertedWithCustomError(vaultHubImpl, "ZeroArgument");
    });

    it("reverts if `_maxRelativeShareLimitBP` is greater than `TOTAL_BASIS_POINTS`", async () => {
      await expect(
        ethers.deployContract("VaultHub", [locator, await locator.lido(), consensusContract, TOTAL_BASIS_POINTS + 1n]),
      )
        .to.be.revertedWithCustomError(vaultHubImpl, "InvalidBasisPoints")
        .withArgs(TOTAL_BASIS_POINTS + 1n, TOTAL_BASIS_POINTS);
    });
  });
});
