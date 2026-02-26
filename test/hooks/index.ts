import * as Mocha from "mocha";

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
    // Dynamic import to avoid circular dependency at config load time
    const { ethers, networkHelpers } = await import("lib/hardhat.js");

    console.log(`#️⃣  Tests started on block number ${await ethers.provider.getBlockNumber()}`);

    await networkHelpers.mine();

    // To prevent issues due to the test addresses having bytecode when forking e.g. Mainnet.
    for (const signer of await ethers.getSigners()) {
      await ethers.provider.send("hardhat_setCode", [signer.address, "0x"]);
    }
  },

  /**
   * This is used to add custom assertions to the Chai assertion library in the test suite when it's run in parallel mode.
   */
  beforeEach(done: Mocha.Done) {
    done();
  },
};
