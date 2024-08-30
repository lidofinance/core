import { expect } from "chai";
import { MaxUint256, TypedDataDomain, TypedDataEncoder, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { EIP712StETH } from "typechain-types";

import { certainAddress } from "lib";

import { Snapshot } from "test/suite";

describe("EIP712StETH.sol", () => {
  let domain: TypedDataDomain;

  let eip712steth: EIP712StETH;

  let originalState: string;

  before(async () => {
    domain = {
      name: "Liquid staked Ether 2.0",
      version: "2",
      chainId: await ethers.provider.send("eth_chainId", []),
      verifyingContract: certainAddress("eip712.test:domain:verifying-contract"),
    };

    const [deployer] = await ethers.getSigners();
    eip712steth = await ethers.deployContract("EIP712StETH", [domain.verifyingContract!], deployer);
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("Reverts if the verifying contract is zero address", async () => {
      const [deployer] = await ethers.getSigners();

      await expect(ethers.deployContract("EIP712StETH", [ZeroAddress], deployer)).to.be.revertedWithCustomError(
        eip712steth,
        "ZeroStETHAddress",
      );
    });
  });

  context("domainSeparatorV4", () => {
    it("Returns the correct domain separator", async () => {
      const expectedSeparator = TypedDataEncoder.hashDomain(domain);

      expect(await eip712steth.domainSeparatorV4(domain.verifyingContract!)).to.equal(expectedSeparator);
    });

    it("Returns the correct non-cached domain separator", async () => {
      const address = certainAddress("some-address"); // Need to be a different address to avoid cache
      const expectedSeparator = TypedDataEncoder.hashDomain({
        ...domain,
        verifyingContract: address,
      });

      expect(await eip712steth.domainSeparatorV4(address)).to.equal(expectedSeparator);
    });
  });

  context("hashTypedDataV4", () => {
    it("Returns the message hash", async () => {
      const types = {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      };

      const values = {
        owner: certainAddress("owner"),
        spender: certainAddress("spender"),
        value: MaxUint256,
        nonce: 0n,
        deadline: MaxUint256,
      };

      const structHash = TypedDataEncoder.from(types).hash(values);

      const expectedHash = TypedDataEncoder.hash(domain, types, values);

      expect(await eip712steth.hashTypedDataV4(domain.verifyingContract!, structHash)).to.equal(expectedHash);
    });
  });

  context("eip712Domain", () => {
    it("Returns the domain data", async () => {
      expect(await eip712steth.eip712Domain(domain.verifyingContract!)).to.deep.equal([
        domain.name,
        domain.version,
        domain.chainId,
        domain.verifyingContract,
      ]);
    });
  });
});
