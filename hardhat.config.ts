import "dotenv/config";
import { configVariable, defineConfig } from "hardhat/config";

import HardhatToolbox from "@nomicfoundation/hardhat-toolbox-mocha-ethers";

import { getHardhatForkingConfig, loadAccounts } from "./hardhat.helpers.js";
import { mochaRootHooks } from "./test/hooks/index.js";

export const ZERO_PK = "0x0000000000000000000000000000000000000000000000000000000000000000";

export default defineConfig({
  plugins: [HardhatToolbox],
  typechain: {
    outDir: "typechain-types",
  },
  test: {
    mocha: {
      rootHooks: mochaRootHooks,
    },
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
      "@openzeppelin/contracts-v5.2/proxy/beacon/UpgradeableBeacon.sol",
      "@aragon/os/contracts/acl/ACL.sol",
      "@aragon/os/contracts/kernel/Kernel.sol",
      "@aragon/os/contracts/lib/ens/ENS.sol",
      "@aragon/os/contracts/factory/DAOFactory.sol",
      "@aragon/os/contracts/factory/EVMScriptRegistryFactory.sol",
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
  networks: {
    "default": {
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
      forking: getHardhatForkingConfig(),
      hardfork: "prague",
      mining: {
        mempool: {
          order: "fifo",
        },
      },
    },
    "custom": {
      type: "http",
      url: configVariable("RPC_URL"),
      timeout: 120_000,
    },
    "local": {
      type: "http",
      url: configVariable("LOCAL_RPC_URL"),
    },
    "local-devnet": {
      type: "http",
      url: configVariable("LOCAL_RPC_URL"),
      accounts: [process.env.LOCAL_DEVNET_PK || ZERO_PK],
    },
    "sepolia": {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
      accounts: loadAccounts("sepolia"),
    },
    "hoodi": {
      type: "http",
      url: configVariable("HOODI_RPC_URL"),
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
      url: configVariable("MAINNET_RPC_URL"),
      timeout: 20 * 60 * 1000, // 20 minutes
    },
    "sepolia-fork": {
      type: "http",
      url: configVariable("SEPOLIA_RPC_URL"),
      chainId: 11155111,
    },
    "hoodi-fork": {
      type: "http",
      url: configVariable("HOODI_RPC_URL"),
      chainId: 560048,
    },
  },
  verify: {
    etherscan: {
      apiKey: configVariable("ETHERSCAN_API_KEY"),
    },
  },
  chainDescriptors: {
    32382: {
      name: "local-devnet",
      blockExplorers: {
        etherscan: {
          name: "local-devnet",
          apiUrl: process.env.LOCAL_DEVNET_EXPLORER_API_URL ?? "",
          url: process.env.LOCAL_DEVNET_EXPLORER_URL ?? "",
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
