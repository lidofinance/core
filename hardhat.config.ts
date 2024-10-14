import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-toolbox";
import "@typechain/hardhat";

import "dotenv/config";
import "solidity-coverage";
import "tsconfig-paths/register";
import "hardhat-tracer";
import "hardhat-watcher";
import "hardhat-ignore-warnings";
import "hardhat-contract-sizer";
import { globSync } from "glob";
import { TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS } from "hardhat/builtin-tasks/task-names";
import { HardhatUserConfig, subtask } from "hardhat/config";

import { mochaRootHooks } from "test/hooks";

import "./tasks";

const RPC_URL: string = process.env.RPC_URL || "";
const ACCOUNTS_PATH = "./accounts.json";

const HARDHAT_FORKING_URL = process.env.HARDHAT_FORKING_URL || "";

const INTEGRATION_WITH_SCRATCH_DEPLOY = process.env.INTEGRATION_WITH_SCRATCH_DEPLOY || "off";

/* Determines the forking configuration for Hardhat */
function getHardhatForkingConfig() {
  if (INTEGRATION_WITH_SCRATCH_DEPLOY === "on" || !HARDHAT_FORKING_URL) {
    return undefined;
  }
  return { url: HARDHAT_FORKING_URL };
}

function loadAccounts(networkName: string) {
  // TODO: this plaintext accounts.json private keys management is a subject
  //       of rework to a solution with the keys stored encrypted
  if (!existsSync(ACCOUNTS_PATH)) {
    return [];
  }
  const content = JSON.parse(readFileSync(ACCOUNTS_PATH, "utf-8"));
  if (!content.eth) {
    return [];
  }
  return content.eth[networkName] || [];
}

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  networks: {
    "local": {
      url: process.env.LOCAL_RPC_URL || RPC_URL,
    },
    "mainnet-fork": {
      url: process.env.MAINNET_RPC_URL || RPC_URL,
      timeout: 20 * 60 * 1000, // 20 minutes
    },
    "hardhat": {
      // setting base fee to 0 to avoid extra calculations doesn't work :(
      // minimal base fee is 1 for EIP-1559
      // gasPrice: 0,
      // initialBaseFeePerGas: 0,
      blockGasLimit: 30000000,
      allowUnlimitedContractSize: true,
      accounts: {
        // default hardhat's node mnemonic
        mnemonic: "test test test test test test test test test test test junk",
        count: 30,
        accountsBalance: "100000000000000000000000",
      },
      forking: getHardhatForkingConfig(),
    },
    "sepolia": {
      url: RPC_URL,
      chainId: 11155111,
      accounts: loadAccounts("sepolia"),
    },
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY || "",
  },
  solidity: {
    compilers: [
      {
        version: "0.4.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "constantinople",
        },
      },
      {
        version: "0.6.11",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
      {
        version: "0.6.12",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
      {
        version: "0.8.4",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
      {
        version: "0.8.9",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
    ],
  },
  tracer: {
    tasks: ["watch"],
  },
  typechain: {
    outDir: "typechain-types",
    target: "ethers-v6",
    alwaysGenerateOverloads: false,
    externalArtifacts: ["externalArtifacts/*.json"],
    dontOverrideCompile: false,
  },
  watcher: {
    test: {
      tasks: [{ command: "test", params: { testFiles: ["{path}"] } }],
      files: ["./test/**/*"],
      clearOnStart: true,
      start: "echo Running tests...",
    },
  },
  mocha: {
    rootHooks: mochaRootHooks,
    timeout: 20 * 60 * 1000, // 20 minutes
  },
  warnings: {
    "@aragon/**/*": {
      default: "off",
    },
    "contracts/*/test_helpers/**/*": {
      default: "off",
    },
    "contracts/*/mocks/**/*": {
      default: "off",
    },
    "test/*/contracts/**/*": {
      default: "off",
    },
    "contracts/common/interfaces/ILidoLocator.sol": {
      default: "off",
    },
  },
  contractSizer: {
    alphaSort: false,
    disambiguatePaths: false,
    runOnCompile: true,
    strict: true,
    except: ["test_helpers", "template", "mocks", "@aragon", "openzeppelin", "test"],
  },
};

// a workaround for having an additional source directory for compilation
// see, https://github.com/NomicFoundation/hardhat/issues/776#issuecomment-1713584386
subtask(TASK_COMPILE_SOLIDITY_GET_SOURCE_PATHS).setAction(async (_, hre, runSuper) => {
  const paths = await runSuper();

  const otherDirectoryGlob = path.join(hre.config.paths.root, "test", "**", "*.sol");
  // Don't need to compile test, helper and script files that are not part of the contracts for Hardhat.
  const otherPaths = globSync(otherDirectoryGlob).filter((x) => !/\.([ths]\.sol)$/.test(x));

  return [...paths, ...otherPaths];
});

export default config;
