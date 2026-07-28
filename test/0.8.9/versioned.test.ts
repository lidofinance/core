import { expect } from "chai";
import hre from "hardhat";

import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import { type HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/types";

import type { Versioned__Harness089 } from "typechain-types/index.js";

import { MAX_UINT256 } from "lib/constants.js";
import { streccak } from "lib/keccak.js";
import { proxify } from "lib/proxy.js";

import { Snapshot } from "test/suite/index.js";

describe("Versioned.sol", () => {
  let ethers: HardhatEthers;

  let admin: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  let impl: Versioned__Harness089;
  let consumer: Versioned__Harness089;

  let originalState: string;

  const initialVersion = 0n;
  const petrifiedVersion = MAX_UINT256;

  before(async () => {
    ({ ethers } = await hre.network.getOrCreate());

    [admin, user] = await ethers.getSigners();

    impl = await ethers.deployContract("Versioned__Harness089");
    [consumer] = await proxify<Versioned__Harness089>({
      impl,
      admin,
      caller: user,
    });
  });

  beforeEach(async () => (originalState = await Snapshot.take()));

  afterEach(async () => await Snapshot.restore(originalState));

  context("constructor", () => {
    it("Petrifies the implementation", async () => {
      expect(await impl.getContractVersion()).to.equal(petrifiedVersion);
    });
  });

  context("getContractVersionPosition", () => {
    it("Returns the storage slot position of the contract version", async () => {
      expect(await consumer.getContractVersionPosition()).to.equal(streccak("lido.Versioned.contractVersion"));
    });
  });

  context("getPetrifiedVersionMark", () => {
    it("Returns the petrification version which should be max uint256", async () => {
      expect(await consumer.getPetrifiedVersionMark()).to.equal(petrifiedVersion);
    });
  });

  context("checkContractVersion", () => {
    it("Passes if the current and expected versions match", async () => {
      await consumer.checkContractVersion(initialVersion);
    });

    it("Reverts if the current and expected versions do not match", async () => {
      const expectedVersion = 1n;
      await expect(consumer.checkContractVersion(expectedVersion)).to.revert(ethers);
    });
  });

  context("initializeContractVersionTo", () => {
    it("Initializes the version from 0 to the specified version", async () => {
      const initVersion = 1n;
      await consumer.initializeContractVersionTo(initVersion);
      expect(await consumer.getContractVersion()).to.equal(initVersion);
    });

    it("Reverts if the previous contract version is not 0", async () => {
      await consumer.updateContractVersion(1);
      await expect(consumer.initializeContractVersionTo(1)).to.revert(ethers);
    });
  });

  context("updateContractVersion", () => {
    it("Updates the contract version incrementally", async () => {
      const newVersion = initialVersion + 1n;
      await consumer.updateContractVersion(newVersion);

      expect(await consumer.getContractVersion()).to.equal(newVersion);
    });

    it("Reverts if the new version is not incremental", async () => {
      const newVersion = initialVersion + 2n;
      await expect(consumer.updateContractVersion(newVersion)).to.revert(ethers);
    });
  });
});
