import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { OssifiableProxy, Versioned__Harness0424 } from "typechain-types";

// TODO: rewrite to be reusable for any derived contract
describe("Versioned.sol", () => {
  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;
  let proxy: OssifiableProxy;
  let impl: Versioned__Harness0424;
  let versioned: Versioned__Harness0424;

  const DEFAULT_VERSION = 0n;
  const INIT_VERSION = 1n;

  before(async () => {
    [admin, user] = await ethers.getSigners();

    // because we have two VersionMocks, we have to specify the full path to the contract
    // which for some reason loses the typing
    impl = await ethers.deployContract("Versioned__Harness0424");
    proxy = await ethers.deployContract("OssifiableProxy", [impl, admin, new Uint8Array()], { from: admin });
    versioned = await ethers.getContractAt("Versioned__Harness0424", proxy, user);
  });

  it("Implementation is petrified.", async () => {
    const petrifiedVersion = await impl.getPetrifiedVersionMark();
    expect(await impl.getContractVersion()).to.equal(petrifiedVersion);
    await expect(impl.checkContractVersion(petrifiedVersion)).not.to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    await expect(impl.checkContractVersion(DEFAULT_VERSION)).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
  });

  it("Default version is zero.", async () => {
    expect(await versioned.getContractVersion()).to.equal(DEFAULT_VERSION);
    await expect(versioned.checkContractVersion(DEFAULT_VERSION)).not.to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    await expect(versioned.checkContractVersion(INIT_VERSION)).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
  });

  it("Correctly updates contract version.", async () => {
    const previousVersion = await versioned.getContractVersion();
    const nextVersion = previousVersion + 1n;
    await expect(versioned.setContractVersion(nextVersion))
      .to.emit(versioned, "ContractVersionSet")
      .withArgs(nextVersion);

    expect(await versioned.getContractVersion()).to.equal(nextVersion);
    await expect(versioned.checkContractVersion(nextVersion)).not.to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
    await expect(versioned.checkContractVersion(previousVersion)).to.be.revertedWith("UNEXPECTED_CONTRACT_VERSION");
  });
});
