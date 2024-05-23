import * as Mocha from "mocha";

import "./assertion/revertedWithOZAccessControlError";

/**
 * This is used to add custom assertions to the Chai assertion library in the test suite when it's run in parallel mode.
 */
export const mochaRootHooks = {
  beforeEach(done: Mocha.Done) {
    done();
  },
};
