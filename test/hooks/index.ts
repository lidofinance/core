import * as Mocha from "mocha";

import "./assertion/equalStETH.js";
import "./assertion/revertedWithOZAccessControlError.js";

// Increase number of stack frames shown in error messages
Error.stackTraceLimit = Infinity;

/**
 * Root hooks. hardhat.config.ts passes them as `rootHooks` for serial runs and lists this file
 * under `require` for parallel runs, where every worker loads it and takes the `mochaHooks` export.
 * Loading the file also registers the custom chai assertions imported above.
 */
export const mochaHooks: Mocha.RootHookObject = {
  /**
   * Mining a block first avoids "No known hardfork for execution on historical block" when
   * forking a fork, see https://github.com/NomicFoundation/hardhat/issues/5511
   */
  async beforeAll() {
    // hardhat.config.ts imports this file, so hardhat itself has to be imported lazily
    const hre = (await import("hardhat")).default;
    const { ethers, networkHelpers } = await hre.network.getOrCreate();

    console.log(`#️⃣  Tests started on block number ${await ethers.provider.getBlockNumber()}`);

    await networkHelpers.mine();

    // Forked networks may hold bytecode at the test signer addresses
    for (const signer of await ethers.getSigners()) {
      await ethers.provider.send("hardhat_setCode", [signer.address, "0x"]);
    }
  },
};
