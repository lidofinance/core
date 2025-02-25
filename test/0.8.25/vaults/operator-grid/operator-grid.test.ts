import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { Accounting, LidoLocator, OperatorGrid, OssifiableProxy, StETH__HarnessForVaultHub } from "typechain-types";

import { ether } from "lib";

import { deployLidoLocator } from "test/deploy";
import { Snapshot } from "test/suite";

describe("Accounting.sol", () => {
  let deployer: HardhatEthersSigner;
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let holder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let proxy: OssifiableProxy;
  let vaultHubImpl: Accounting;
  let accounting: Accounting;
  let steth: StETH__HarnessForVaultHub;
  let locator: LidoLocator;
  let operatorGrid: OperatorGrid;

  let originalState: string;

  before(async () => {
    [deployer, admin, user, holder, stranger] = await ethers.getSigners();

    locator = await deployLidoLocator();
    steth = await ethers.deployContract("StETH__HarnessForVaultHub", [holder], {
      value: ether("10.0"),
      from: deployer,
    });
    operatorGrid = await ethers.deployContract("OperatorGrid", { from: deployer });

    // VaultHub
    vaultHubImpl = await ethers.deployContract("Accounting", [locator, steth, operatorGrid], { from: deployer });

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

      console.log(accounting);
    });
  });
});
