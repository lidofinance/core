import path from "node:path";
import * as process from "node:process";

import { globSync } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS, TASK_TEST_GET_TEST_FILES } from "hardhat/builtin-tasks/task-names";
import { subtask } from "hardhat/config";

/**
 * This is a workaround for having an additional source directory for compilation.
 * It allows Solidity files in the test directory to be compiled alongside the main contracts.
 *
 * Reference: https://github.com/NomicFoundation/hardhat/issues/776#issuecomment-1713584386
 */
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (_, hre, runSuper) => {
  const paths = await runSuper();

  const otherDirectoryGlob = path.join(hre.config.paths.root, "test", "**", "*.sol");
  // Exclude test, helper and script files (those ending with .t.sol, .h.sol, or .s.sol)
  // as they are not part of the contracts that need to be compiled for Hardhat.
  const otherPaths = globSync(otherDirectoryGlob).filter((x) => !/\.([ths]\.sol)$/.test(x));

  return [...paths, ...otherPaths];
});

/**
 * This is a workaround for skipping integration tests when coverage is enabled.
 */
subtask(TASK_TEST_GET_TEST_FILES).setAction(async (_, __, runSuper) => {
  const paths = await runSuper();
  if (process.env.COVERAGE === "unit") {
    return paths.filter((x: string) => !x.includes("test/integration/"));
  }
  if (process.env.COVERAGE === "integration") {
    return paths.filter((x: string) => !x.includes(".test.ts"));
  }
  return paths;
});
