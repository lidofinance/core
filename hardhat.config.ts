import { randomBytes } from "node:crypto";

import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";
import type { EdrNetworkUserConfig } from "hardhat/types/config";
import HardhatIgnoreWarnings from "hardhat-ignore-warnings";

import HardhatToolbox from "@nomicfoundation/hardhat-toolbox-mocha-ethers";
import HardhatContractSizer from "@solidstate/hardhat-contract-sizer";

import { getHardhatForkingConfig, getRpcUrl, loadAccounts } from "./hardhat.helpers.js";
import { tasks } from "./tasks/index.js";
import { txLoggerPlugin } from "./tasks/tx-logger.js";
import { mochaHooks } from "./test/hooks/index.js";

export const ZERO_PK = "0x0000000000000000000000000000000000000000000000000000000000000000";

const LOCAL_DEVNET_CHAIN_ID = parseInt(process.env.LOCAL_DEVNET_CHAIN_ID ?? "32382", 10);

const DEEP_FUZZING = process.env.FUZZ_PROFILE === "deep";
const FUZZ_SEED = process.env.FUZZ_SEED ?? `0x${randomBytes(32).toString("hex")}`;
if (DEEP_FUZZING) console.log(`Fuzz seed: ${FUZZ_SEED}`);

const simulatedNetwork = {
  type: "edr-simulated",
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
    accountsBalance: "10000000000000000000000000",
  },
  hardfork: "prague",
  mining: {
    mempool: {
      order: "fifo",
    },
  },
} satisfies EdrNetworkUserConfig;

export default defineConfig({
  plugins: [HardhatToolbox, HardhatContractSizer, HardhatIgnoreWarnings, txLoggerPlugin],
  tasks,
  coverage: {
    // globs are relative to the project root: `contracts/` prefix, `/**` for directories
    skipFiles: [
      "contracts/common/interfaces/**",
      "contracts/0.4.24/template/**",
      "contracts/0.6.11/deposit_contract.sol",
      "contracts/0.6.12/interfaces/**",
      "contracts/0.8.9/interfaces/**",
      "contracts/openzeppelin/**",
      "contracts/upgrade/**",
      // mocks and harnesses: `paths.sources` includes `test`, so they would be instrumented
      "test/**",
    ],
  },
  contractSizer: {
    alphaSort: false,
    runOnCompile: process.env.SKIP_CONTRACT_SIZE ? false : true,
    strict: false,
    except: [/template/, /mocks/, /@aragon/, /openzeppelin/, /test/],
  },
  typechain: {
    outDir: "typechain-types",
  },
  test: {
    mocha: {
      timeout: 20 * 60 * 1000, // 20 minutes
      // serial runs take rootHooks; parallel workers ignore them and load the file from `require`
      rootHooks: mochaHooks,
      require: ["test/hooks/index.ts"],
      parallel: process.env.PARALLEL === "true",
    },
    // Certification fuzzing. HH3 has a single solidity-test profile, hence the env switch.
    // Inline `forge-config: default.*` comments override these values in both modes; Foundry skipped
    // them under FOUNDRY_PROFILE=deep. HH3 pins the fuzz seed; deep runs draw a fresh one unless
    // FUZZ_SEED is set.
    solidity: DEEP_FUZZING
      ? {
          fuzz: { runs: 10_000, maxTestRejects: 10_000_000, seed: FUZZ_SEED },
          invariant: { runs: 10_000, depth: 500 },
        }
      : {},
  },
  paths: {
    sources: {
      solidity: ["contracts", "test"],
    },
    tests: {
      mocha: "test",
    },
  },
  solidity: {
    npmFilesToBuild: [
      "@aragon/apps-agent/contracts/Agent.sol",
      "@aragon/apps-finance/contracts/Finance.sol",
      "@aragon/apps-lido/apps/token-manager/contracts/TokenManager.sol",
      "@aragon/apps-lido/apps/voting/contracts/Voting.sol",
      "@aragon/id/contracts/FIFSResolvingRegistrar.sol",
      "@aragon/minime/contracts/MiniMeToken.sol",
      "@aragon/os/contracts/acl/ACL.sol",
      "@aragon/os/contracts/apm/APMRegistry.sol",
      "@aragon/os/contracts/apm/Repo.sol",
      "@aragon/os/contracts/ens/ENSSubdomainRegistrar.sol",
      "@aragon/os/contracts/factory/APMRegistryFactory.sol",
      "@aragon/os/contracts/factory/DAOFactory.sol",
      "@aragon/os/contracts/factory/ENSFactory.sol",
      "@aragon/os/contracts/factory/EVMScriptRegistryFactory.sol",
      "@aragon/os/contracts/apps/AppProxyPinned.sol",
      "@aragon/os/contracts/apps/AppProxyUpgradeable.sol",
      "@aragon/os/contracts/evmscript/EVMScriptRegistry.sol",
      "@aragon/os/contracts/evmscript/executors/CallsScript.sol",
      "@aragon/os/contracts/kernel/Kernel.sol",
      "@aragon/os/contracts/kernel/KernelProxy.sol",
      "@aragon/os/contracts/lib/ens/ENS.sol",
      "@aragon/os/contracts/lib/misc/ERCProxy.sol",
      "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol",
      "@openzeppelin/contracts/token/ERC20/ERC20.sol",
      "@openzeppelin/contracts/token/ERC20/IERC20.sol",
      "@openzeppelin/contracts/token/ERC721/ERC721.sol",
    ],
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
        version: "0.8.9",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          evmVersion: "istanbul",
        },
      },
      {
        version: "0.8.25",
        settings: {
          optimizer: {
            enabled: true,
            runs: 200,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    ],
    overrides: {
      // NB: Decreasing optimizer "runs" parameter to reduce VaultHub contract size.
      // TODO: Reconsider this override after VaultHub's source code is settled.
      "contracts/0.8.25/vaults/VaultHub.sol": {
        version: "0.8.25",
        settings: {
          optimizer: {
            enabled: true,
            runs: 100,
          },
          viaIR: true,
          evmVersion: "cancun",
        },
      },
    },
  },
  warnings: {
    "npm/@aragon/**/*": { default: "off" },
    "contracts/*/mocks/**/*": { default: "off" },
    "test/**/contracts/**/*": { default: "off" },
    "contracts/common/interfaces/ILidoLocator.sol": { default: "off" },
  },
  networks: {
    "default": {
      ...simulatedNetwork,
      forking: getHardhatForkingConfig(),
    },
    // `hardhat node` connects here; run-fork-node.sh passes the fork chain id via --chain-id
    "node": simulatedNetwork,
    "custom": {
      type: "http",
      url: configVariable("RPC_URL"),
      timeout: 120_000,
    },
    "local": {
      type: "http",
      url: getRpcUrl("LOCAL_RPC_URL"),
      timeout: 20 * 60 * 1000, // 20 minutes
    },
    "local-devnet": {
      type: "http",
      url: getRpcUrl("LOCAL_RPC_URL"),
      timeout: 20 * 60 * 1000, // 20 minutes
      accounts: [process.env.LOCAL_DEVNET_PK || ZERO_PK],
      chainId: LOCAL_DEVNET_CHAIN_ID,
    },
    "sepolia": {
      type: "http",
      url: getRpcUrl("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      accounts: loadAccounts("sepolia"),
    },
    "hoodi": {
      type: "http",
      url: getRpcUrl("HOODI_RPC_URL"),
      chainId: 560048,
      accounts: loadAccounts("hoodi"),
    },
    "mainnet": {
      type: "http",
      url: configVariable("RPC_URL"),
      chainId: 1,
      accounts: loadAccounts("mainnet"),
    },
    "mainnet-fork": {
      type: "http",
      url: getRpcUrl("MAINNET_RPC_URL"),
      timeout: 20 * 60 * 1000, // 20 minutes
    },
    "sepolia-fork": {
      type: "http",
      url: getRpcUrl("SEPOLIA_RPC_URL"),
      chainId: 11155111,
    },
    "hoodi-fork": {
      type: "http",
      url: getRpcUrl("HOODI_RPC_URL"),
      chainId: 560048,
    },
  },
  verify: {
    etherscan: {
      apiKey: process.env.LOCAL_DEVNET_EXPLORER_API_URL ? "local-devnet" : configVariable("ETHERSCAN_API_KEY"),
    },
  },
  chainDescriptors: {
    [LOCAL_DEVNET_CHAIN_ID]: {
      name: "local-devnet",
      hardforkHistory: {
        prague: { blockNumber: 0 },
      },
      blockExplorers: {
        etherscan: {
          name: "local-devnet",
          apiUrl: process.env.LOCAL_DEVNET_EXPLORER_API_URL ?? "http://localhost:3080/api",
          url: process.env.LOCAL_DEVNET_EXPLORER_URL ?? "http://localhost:3080",
        },
      },
    },
    17000: {
      name: "holesky",
      blockExplorers: {
        etherscan: {
          name: "holesky",
          apiUrl: "https://api-holesky.etherscan.io/api",
          url: "https://holesky.etherscan.io/",
        },
      },
    },
    11155111: {
      name: "sepolia",
      blockExplorers: {
        etherscan: {
          name: "sepolia",
          apiUrl: "https://api-sepolia.etherscan.io/api",
          url: "https://sepolia.etherscan.io/",
        },
      },
    },
    560048: {
      name: "hoodi",
      blockExplorers: {
        etherscan: {
          name: "hoodi",
          apiUrl: "https://api-hoodi.etherscan.io/api",
          url: "https://hoodi.etherscan.io/",
        },
      },
    },
  },
});
