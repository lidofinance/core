import { expect } from "chai";
import { type Signature, type Signer, ZeroAddress } from "ethers";
import hre from "hardhat";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import type { NetworkHelpers } from "@nomicfoundation/hardhat-network-helpers/types";

import type { StETHPermit__HarnessWithEip712Initialization } from "typechain-types/index.js";

import { certainAddress } from "lib/address.js";
import { type Permit, signPermit, stethDomain } from "lib/eips/eip712.js";
import { days } from "lib/time.js";
import { ether } from "lib/units.js";

import { Snapshot } from "test/suite/index.js";

describe("StETHPermit.sol", () => {
  let ethers: HardhatEthers;
  let networkHelpers: NetworkHelpers;

  let deployer: Signer;
  let signer: Signer;

  let originalState: string;
  let permit: Permit;
  let signature: Signature;

  let steth: StETHPermit__HarnessWithEip712Initialization;

  before(async () => {
    ({ ethers, networkHelpers } = await hre.network.getOrCreate());

    [deployer, signer] = await ethers.getSigners();

    steth = await ethers.deployContract("StETHPermit__HarnessWithEip712Initialization", [signer], {
      value: ether("10.0"),
      from: deployer,
    });

    const holderBalance = await steth.balanceOf(signer);

    permit = {
      owner: await signer.getAddress(),
      spender: certainAddress("spender"),
      value: holderBalance,
      nonce: await steth.nonces(signer),
      deadline: BigInt(await networkHelpers.time.latest()) + days(7n),
    };

    signature = await signPermit(await stethDomain(steth), permit, signer);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("initialize", () => {
    it("Reverts if the EIP-712 helper contract is zero address", async () => {
      await expect(steth.initializeEIP712StETH(ZeroAddress)).to.be.revertedWith("ZERO_EIP712STETH");
    });

    it("Reverts if the EIP-712 helper contract is already set", async () => {
      const eip712helper = certainAddress("eip712helper");
      await expect(steth.initializeEIP712StETH(eip712helper))
        .to.be.emit(steth, "EIP712StETHInitialized")
        .withArgs(eip712helper);
      expect(await steth.getEIP712StETH()).to.equal(eip712helper);

      await expect(steth.initializeEIP712StETH(eip712helper)).to.be.revertedWith("EIP712STETH_ALREADY_SET");
    });

    it("Initializes the EIP-712 Steth helper and emits the 'EIP712StETHInitialized' event", async () => {
      const eip712helper = certainAddress("eip712helper");

      await expect(steth.initializeEIP712StETH(eip712helper))
        .to.be.emit(steth, "EIP712StETHInitialized")
        .withArgs(eip712helper);
      expect(await steth.getEIP712StETH()).to.equal(eip712helper);
    });
  });

  context("Uninitialized", () => {
    it("Permit reverts", async () => {
      const { owner, spender, deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(steth.permit(owner, spender, value, deadline, v, r, s)).to.revert(ethers);
    });

    it("eip712Domain() reverts", async () => {
      await expect(steth.eip712Domain()).to.be.revertedWithoutReason(ethers);
    });
  });

  context("Initialized", () => {
    beforeEach(async () => {
      const eip712helper = await ethers.deployContract("EIP712StETH", [steth], deployer);
      await steth.initializeEIP712StETH(eip712helper);
    });

    it("Permit executes successfully", async () => {
      const { owner, spender, deadline, value } = permit;
      const { v, r, s } = signature;

      await expect(steth.permit(owner, spender, value, deadline, v, r, s)).not.to.revert(ethers);
    });

    it("eip712Domain() returns the EIP-712 domain", async () => {
      const domain = await stethDomain(steth);
      expect(await steth.eip712Domain()).to.deep.equal([
        domain.name,
        domain.version,
        domain.chainId,
        domain.verifyingContract,
      ]);
    });
  });
});
