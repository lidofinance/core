import { TASK_COMPILE } from "hardhat/builtin-tasks/task-names";
import { task } from "hardhat/config";
import { HardhatRuntimeEnvironment, RunSuperFunction } from "hardhat/types";

task(TASK_COMPILE, "Compile contracts").setAction(
  async (_: unknown, hre: HardhatRuntimeEnvironment, runSuper: RunSuperFunction<unknown>) => {
    await runSuper();

    if (process.env.SKIP_LINT_SOLIDITY) {
      console.log("Skipping lint-solidity upon compile because SKIP_LINT_SOLIDITY is set");
    } else {
      await hre.run("lint-solidity");
    }

    if (process.env.SKIP_INTERFACES_CHECK) {
      console.log("Skipping interfaces check upon compile because SKIP_INTERFACES_CHECK is set");
    } else {
      await hre.run("check-interfaces");
    }
  },
);
