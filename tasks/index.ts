import { buildOverrideTask } from "./build.js";
import { checkInterfacesTask } from "./check-interfaces.js";
import { extractAbisTask } from "./extract-abis.js";
import { lintSolidityTask } from "./lint-solidity.js";
import { protocolGetAddressesTask } from "./protocol-get-addresses.js";
import { validateConfigsTask } from "./validate-configs.js";
import { verifyDeployedTask } from "./verify-contracts.js";

export const tasks = [
  buildOverrideTask,
  checkInterfacesTask,
  extractAbisTask,
  lintSolidityTask,
  protocolGetAddressesTask,
  validateConfigsTask,
  verifyDeployedTask,
];
