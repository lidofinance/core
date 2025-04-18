import * as Mocha from "mocha";

import { mine } from "@nomicfoundation/hardhat-network-helpers";

import "./assertion/revertedWithOZAccessControlError";

export const mochaRootHooks: Mocha.RootHookObject = {
  /**
   * This mine before all tests is to fix an error "No known hardfork for execution on historical block"
   * when forking other fork e.g. hardhat forking hardhat
   * See https://github.com/NomicFoundation/hardhat/issues/5511
   */
  async beforeAll() {
    await mine();
  },

  /**
   * This is used to add custom assertions to the Chai assertion library in the test suite when it's run in parallel mode.
   */
  beforeEach(done: Mocha.Done) {
    done();
  },
};
