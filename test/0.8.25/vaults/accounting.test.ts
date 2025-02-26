import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Accounting, LidoLocator, OssifiableProxy, StETH__Harness } from "typechain-types";

import { ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, VAULTS_CONNECTED_VAULTS_LIMIT, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

describe("Accounting.sol", () => {
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let proxy: OssifiableProxy;
  let vaultHubImpl: Accounting;
  let accounting: Accounting;
  let steth: StETH__Harness;
  let locator: LidoLocator;

  let originalState: string;

  before(async () => {
    [admin, user, holder, stranger] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__Harness", [holder], { value: ether("10.0") });

    // VaultHub
    vaultHubImpl = await ethers.deployContract("Accounting", [
      locator,
      steth,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, admin, new Uint8Array()], admin);

    accounting = await ethers.getContractAt("Accounting", proxy, user);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("reverts on impl initialization", async () => {
      await expect(vaultHubImpl.initialize(stranger)).to.be.revertedWithCustomError(
        vaultHubImpl,
        "InvalidInitialization",
      );
    });
    it("reverts on `_admin` address is zero", async () => {
      await expect(accounting.initialize(ZeroAddress))
        .to.be.revertedWithCustomError(vaultHubImpl, "ZeroArgument")
        .withArgs("_admin");
    });
    it("initialization happy path", async () => {
      const tx = await accounting.initialize(admin);

      expect(await accounting.vaultsCount()).to.eq(0);

      await expect(tx).to.be.emit(accounting, "Initialized").withArgs(1);
    });
  });
});
