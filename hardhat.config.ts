import * as process from "node:process";

import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/ethereumjs-util";
import "@nomicfoundation/hardhat-verify";
import "@typechain/hardhat";

import "dotenv/config";
import "solidity-coverage";
import "tsconfig-paths/register";
import "hardhat-tracer";
import "hardhat-watcher";
import "hardhat-ignore-warnings";
import "hardhat-contract-sizer";
import "hardhat-gas-reporter";
import { HardhatUserConfig } from "hardhat/config";

import { mochaRootHooks } from "test/hooks";

import "./tasks";

import { getHardhatForkingConfig, loadAccounts } from "./hardhat.helpers";

const RPC_URL: string = process.env.RPC_URL || "";

export const ZERO_PK = "0x0000000000000000000000000000000000000000000000000000000000000000";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  gasReporter: {
    enabled: !process.env.SKIP_GAS_REPORT,
    reportPureAndViewMethods: true,
    etherscan: process.env.ETHERSCAN_API_KEY || "",
  },
  networks: {
    "hardhat": {
      // setting base fee to 0 to avoid extra calculations doesn't work :(
      // minimal base fee is 1 for EIP-1559
      // gasPrice: 0,
      // initialBaseFeePerGas: 0,
      // Hardhat does NOT inherit the forked chain's chainId (it defaults to
      // 31337), and `hardhat node` has no --chainId flag. Set HARDHAT_CHAIN_ID
      // to the source chain's id (e.g. 11155111 for Sepolia) so chainId-keyed
      // deploy branches behave as on the real network. Leave unset for 31337.
      chainId: process.env.HARDHAT_CHAIN_ID ? Number(process.env.HARDHAT_CHAIN_ID) : 31337,
      blockGasLimit: 30000000,
      allowUnlimitedContractSize: true,
      accounts: {
        // default hardhat's node mnemonic
        mnemonic: "test test test test test test test test test test test junk",
        count: 30,
        accountsBalance: "10000000000000000000000000",
      },
      forking: getHardhatForkingConfig(),
      hardfork: "prague",
      mining: {
        mempool: {
          order: "fifo",
        },
      },
    },
    "custom": {
      url: RPC_URL,
      timeout: 120_000,
    },
    // local nodes
    "local": {
      url: process.env.LOCAL_RPC_URL || RPC_URL,
      timeout: 120_000,
    },
    "local-devnet": {
      url: process.env.LOCAL_RPC_URL || RPC_URL,
      accounts: [process.env.LOCAL_DEVNET_PK || ZERO_PK],
    },
    // testnets — long RPC timeout to survive occasional Infura/Alchemy
    // headers stalls during long scratch deploys.
    "sepolia": {
      url: process.env.SEPOLIA_RPC_URL || RPC_URL,
      chainId: 11155111,
      accounts: loadAccounts("sepolia"),
      timeout: 120_000,
    },
    "hoodi": {
      url: process.env.HOODI_RPC_URL || RPC_URL,
      chainId: 560048,
      accounts: loadAccounts("hoodi"),
      timeout: 120_000,
    },
    "mainnet": {
      url: RPC_URL,
      chainId: 1,
      accounts: loadAccounts("mainnet"),
    },
    // forks
    "mainnet-fork": {
      url: process.env.MAINNET_RPC_URL || RPC_URL,
      timeout: 20 * 60 * 1000, // 20 minutes
    },
    "sepolia-fork": {
      url: process.env.SEPOLIA_RPC_URL || RPC_URL,
      chainId: 11155111,
    },
    "hoodi-fork": {
      url: process.env.HOODI_RPC_URL || RPC_URL,
      chainId: 560048,
    },
  },
  etherscan: {
    customChains: [
      {
        network: "local-devnet",
        chainId: 32382,
        urls: {
          apiURL: "http://localhost:3080/api",
          browserURL: "http://localhost:3080",
        },
      },
      {
        network: "hoodi",
        chainId: 560048,
        urls: {
          apiURL: "https://api-hoodi.etherscan.io/api",
          browserURL: "https://hoodi.etherscan.io/",
        },
      },
      {
        network: "local-devnet",
        chainId: parseInt(process.env.LOCAL_DEVNET_CHAIN_ID ?? "32382", 10),
        urls: {
          apiURL: process.env.LOCAL_DEVNET_EXPLORER_API_URL ?? "",
          browserURL: process.env.LOCAL_DEVNET_EXPLORER_URL ?? "",
        },
      },
      {
        network: "holesky",
        chainId: 17000,
        urls: {
          apiURL: "https://api-holesky.etherscan.io/api",
          browserURL: "https://holesky.etherscan.io/",
        },
      },
      {
        network: "sepolia",
        chainId: 11155111,
        urls: {
          apiURL: "https://api-sepolia.etherscan.io/api",
          browserURL: "https://sepolia.etherscan.io/",
        },
      },
      {
        network: "hoodi",
        chainId: 560048,
        urls: {
          apiURL: "https://api-hoodi.etherscan.io/api",
          browserURL: "https://hoodi.etherscan.io/",
        },
      },
    ],
    apiKey: process.env.LOCAL_DEVNET_EXPLORER_API_URL ? "local-devnet" : process.env.ETHERSCAN_API_KEY || "",
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
      // NB: low optimizer `runs` keeps LidoTemplate under the 24KB EIP-170 limit
      // after the DG-finalization additions (finalizePermissionsAfterDGDeployment,
      // finalizePermissionsWithoutDGDeployment, _finalizePermissions). solc 0.4.24
      // predates the IR pipeline, so `viaIR` is a no-op here — the size win is
      // entirely from `runs`; the rest of the config matches the base 0.4.24 block.
      "contracts/0.4.24/template/LidoTemplate.sol": {
        version: "0.4.24",
        settings: {
          optimizer: {
            enabled: true,
            runs: 50,
          },
          evmVersion: "constantinople",
        },
      },
    },
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
      tasks: [
        { command: "compile", params: { quiet: true } },
        { command: "test", params: { noCompile: true, testFiles: ["{path}"] } },
      ],
      files: ["./test/**/*"],
      clearOnStart: true,
      start: "echo Running tests...",
    },
  },
  mocha: {
    fullTrace: true,
    rootHooks: mochaRootHooks,
    timeout: 20 * 60 * 1000, // 20 minutes
  },
  warnings: {
    "@aragon/**/*": {
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
    runOnCompile: process.env.SKIP_CONTRACT_SIZE ? false : true,
    strict: false,
    except: ["template", "mocks", "@aragon", "openzeppelin", "test"],
  },
};

export default config;
