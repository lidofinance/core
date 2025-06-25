import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle__Harness } from "typechain-types";

import { deployAndConfigureAccountingOracle } from "test/deploy";

describe("AccountingOracle.sol:upgrade", () => {
  context("finalizeUpgrade_v2", () => {
    let admin: HardhatEthersSigner;
    let oracle: AccountingOracle__Harness;
    const NEW_CONSENSUS_VERSION = 42n; // Just a test value

    beforeEach(async () => {
      [admin] = await ethers.getSigners();
      const deployed = await deployAndConfigureAccountingOracle(admin.address);
      oracle = deployed.oracle;
      await oracle.setContractVersion(1); // Set initial contract version to 1
    });

    it("successfully updates contract and consensus versions", async () => {
      // Get initial versions
      const initialContractVersion = await oracle.getContractVersion();
      const initialConsensusVersion = await oracle.getConsensusVersion();

      // Call finalizeUpgrade_v2
      await oracle.connect(admin).finalizeUpgrade_v2(NEW_CONSENSUS_VERSION);

      // Verify contract version updated to 2
      const newContractVersion = await oracle.getContractVersion();
      expect(newContractVersion).to.equal(2);
      expect(newContractVersion).to.not.equal(initialContractVersion);

      // Verify consensus version updated to the provided value
      const newConsensusVersion = await oracle.getConsensusVersion();
      expect(newConsensusVersion).to.equal(NEW_CONSENSUS_VERSION);
      expect(newConsensusVersion).to.not.equal(initialConsensusVersion);
    });
  });

  context("finalizeUpgrade_v3", () => {
    let admin: HardhatEthersSigner;
    let oracle: AccountingOracle__Harness;

    beforeEach(async () => {
      [admin] = await ethers.getSigners();
      const deployed = await deployAndConfigureAccountingOracle(admin.address);
      oracle = deployed.oracle;
      await oracle.setContractVersion(2); // Set initial contract version to 1
    });

    it("successfully updates contract and consensus versions", async () => {
      // Get initial versions
      const initialContractVersion = await oracle.getContractVersion();

      // Call finalizeUpgrade_v2
      await oracle.connect(admin).finalizeUpgrade_v3();

      // Verify contract version updated to 2
      const newContractVersion = await oracle.getContractVersion();
      expect(newContractVersion).to.equal(3);
      expect(newContractVersion).to.not.equal(initialContractVersion);
    });
  });
});
