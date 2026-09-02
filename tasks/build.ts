import { overrideTask } from "hardhat/config";

export const buildOverrideTask = overrideTask("build")
  .setInlineAction(async (taskArgs, hre, runSuper) => {
    const result = await runSuper(taskArgs);

    if (process.env.SKIP_LINT_SOLIDITY) {
      console.log("Skipping lint-solidity upon compile because SKIP_LINT_SOLIDITY is set");
    } else {
      await hre.tasks.getTask("lint-solidity").run();
    }

    if (process.env.SKIP_INTERFACES_CHECK) {
      console.log("Skipping interfaces check upon compile because SKIP_INTERFACES_CHECK is set");
    } else {
      await hre.tasks.getTask("check-interfaces").run();
    }

    return result;
  })
  .build();
