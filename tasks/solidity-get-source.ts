import path from "node:path";

import { globSync } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import { subtask } from "hardhat/config";

// a workaround for having an additional source directory for compilation
// see, https://github.com/NomicFoundation/hardhat/issues/776#issuecomment-1713584386

subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (_, hre, runSuper) => {
  const paths = await runSuper();

  const otherDirectoryGlob = path.join(hre.config.paths.root, "test", "**", "*.sol");
  // Don't need to compile test, helper and script files that are not part of the contracts for Hardhat.
  const otherPaths = globSync(otherDirectoryGlob).filter((x) => !/\.([ths]\.sol)$/.test(x));

  return [...paths, ...otherPaths];
});
