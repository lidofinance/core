import * as Mocha from "mocha";

import { mine } from "@nomicfoundation/hardhat-network-helpers";

import "./assertion/revertedWithOZAccessControlError";

// Increase number of stack frames shown in error messages
Error.stackTraceLimit = Infinity;

export const mochaRootHooks: Mocha.RootHookObject = {
  /**
   * This mine before all tests is to fix an error "No known hardfork for execution on historical block"
   * when forking other fork e.g. hardhat forking hardhat
   * See https://github.com/NomicFoundation/hardhat/issues/5511
   *
   * This is also used to add custom assertions to the Chai assertion library in the test suite when it's run in parallel mode.
   */
  async beforeAll() {
    const hre = await import("hardhat");

    console.log(`#️⃣  Tests started on block number ${await hre.ethers.provider.getBlockNumber()}`);

    await mine();

    // To prevent issues due to the test addresses having bytecode when forking e.g. Mainnet.
    // NB: hardhat cannot be imported the regular way here because it is yet being initialized.
    for (const signer of await hre.ethers.getSigners()) {
      await hre.ethers.provider.send("hardhat_setCode", [signer.address, "0x"]);
    }
  },

  /**
   * This is used to add custom assertions to the Chai assertion library in the test suite when it's run in parallel mode.
   */
  beforeEach(done: Mocha.Done) {
    done();
  },
};
