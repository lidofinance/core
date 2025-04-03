import { expect } from "chai";
import { ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  LidoLocator,
  OperatorGrid,
  OssifiableProxy,
  StETH__Harness,
  VaultHub,
  WstETH__HarnessForVault,
} from "typechain-types";

import { ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot, VAULTS_CONNECTED_VAULTS_LIMIT, VAULTS_RELATIVE_SHARE_LIMIT_BP } from "test/suite";

describe("VaultHub.sol", () => {
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let proxy: OssifiableProxy;
  let vaultHubImpl: VaultHub;
  let steth: StETH__Harness;
  let wsteth: WstETH__HarnessForVault;
  let locator: LidoLocator;
  let vaultHub: VaultHub;
  let operatorGrid: OperatorGrid;
  let operatorGridImpl: OperatorGrid;

  let originalState: string;

  before(async () => {
    [admin, user, holder, stranger] = await ethers.getSigners();

    steth = await ethers.deployContract("StETH__Harness", [holder], { value: ether("10.0") });
    wsteth = await ethers.deployContract("WstETH__HarnessForVault", [steth]);
    locator = await deployLidoLocator({
      lido: steth,
      wstETH: wsteth,
    });

    // OperatorGrid
    operatorGridImpl = await ethers.deployContract("OperatorGrid", [locator], { from: admin });
    proxy = await ethers.deployContract("OssifiableProxy", [operatorGridImpl, admin, new Uint8Array()], admin);
    operatorGrid = await ethers.getContractAt("OperatorGrid", proxy, admin);
    await operatorGrid.initialize(admin);
    await operatorGrid.connect(admin).grantRole(await operatorGrid.REGISTRY_ROLE(), admin);

    // VaultHub
    vaultHubImpl = await ethers.deployContract("VaultHub", [
      locator,
      await locator.lido(),
      operatorGrid,
      VAULTS_CONNECTED_VAULTS_LIMIT,
      VAULTS_RELATIVE_SHARE_LIMIT_BP,
    ]);

    proxy = await ethers.deployContract("OssifiableProxy", [vaultHubImpl, admin, new Uint8Array()], admin);

    vaultHub = await ethers.getContractAt("VaultHub", proxy, user);
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
      await expect(vaultHub.initialize(ZeroAddress))
        .to.be.revertedWithCustomError(vaultHub, "ZeroArgument")
        .withArgs("_admin");
    });
    it("initialization happy path", async () => {
      const tx = await vaultHub.initialize(admin);

      expect(await vaultHub.vaultsCount()).to.eq(0);

      await expect(tx).to.be.emit(vaultHub, "Initialized").withArgs(1);
    });
  });
});
