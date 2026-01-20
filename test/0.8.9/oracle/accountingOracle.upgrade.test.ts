import { expect } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { AccountingOracle__Harness } from "typechain-types";

import { deployAndConfigureAccountingOracle } from "test/deploy";

describe("AccountingOracle.sol:upgrade", () => {
  context("finalizeUpgrade_v3", () => {
    let admin: HardhatEthersSigner;
    let oracle: AccountingOracle__Harness;
    const NEW_CONSENSUS_VERSION = 42n; // Just a test value

    beforeEach(async () => {
      [admin] = await ethers.getSigners();
      const deployed = await deployAndConfigureAccountingOracle(admin.address);
      oracle = deployed.oracle;
      await oracle.setContractVersion(3); // Set initial contract version to 3
    });

    // TODO: test version increment because finalizeUpgrade_v4 should be called on a v2 contract
    it("successfully updates contract and consensus versions", async () => {
      // Get initial versions
      const initialContractVersion = await oracle.getContractVersion();
      const initialConsensusVersion = await oracle.getConsensusVersion();

      await oracle.connect(admin).finalizeUpgrade_v4(NEW_CONSENSUS_VERSION);

      const newContractVersion = await oracle.getContractVersion();
      expect(newContractVersion).to.equal(4);
      expect(newContractVersion).to.not.equal(initialContractVersion);

      // Verify consensus version updated to the provided value
      const newConsensusVersion = await oracle.getConsensusVersion();
      expect(newConsensusVersion).to.equal(NEW_CONSENSUS_VERSION);
      expect(newConsensusVersion).to.not.equal(initialConsensusVersion);
    });
  });
});
