import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import { anvilStart, anvilStop } from "./test/anvil-setup";

const config: HardhatUserConfig = {
  defaultNetwork: "anvil",
  networks: {
    anvil: {
      url: "http://127.0.0.1:8545",
      forking: {
        url: process.env.RPC_URL ?? "",
      },
      loggingEnabled: true,
    },
  },
  mocha: {
    rootHooks: {
      beforeAll: async () => {
        await anvilStart();
      },
      afterAll: async () => {
        await anvilStop();
      },
    },
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
    ],
  },
};

export default config;
