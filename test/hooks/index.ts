import * as Mocha from "mocha";

import "./assertion/revertedWithOZAccessControlError";

// Increase number of stack frames shown in error messages
Error.stackTraceLimit = Infinity;

/**
 * This is used to add custom assertions to the Chai assertion library in the test suite when it's run in parallel mode.
 */
export const mochaRootHooks: Mocha.RootHookObject = {
  async beforeAll() {
    // To prevent issues due to the test addresses having bytecode when forking e.g. Mainnet.
    // NB: hardhat cannot be imported the regular way here because it is yet being initialized.
    const hre = await import("hardhat");
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
