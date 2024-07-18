import { ProtocolNetworkConfig } from "./types";

/**
 * Network configuration for the protocol discovery in the test environment.
 */
const local: ProtocolNetworkConfig = {
  env: {
    locator: "LOCAL_LOCATOR_ADDRESS",
    agent: "LOCAL_AGENT_ADDRESS",
    voting: "LOCAL_VOTING_ADDRESS",
    easyTrack: "LOCAL_EASY_TRACK_EXECUTOR_ADDRESS",
  },
  defaults: {
    locator: "",
    agent: "",
    voting: "",
    easyTrack: "",
  },
};

/**
 * Network configuration for the protocol discovery in the mainnet environment.
 */
const mainnet: ProtocolNetworkConfig = {
  env: {
    locator: "MAINNET_LOCATOR_ADDRESS",
    agent: "MAINNET_AGENT_ADDRESS",
    voting: "MAINNET_VOTING_ADDRESS",
    easyTrack: "MAINNET_EASY_TRACK_EXECUTOR_ADDRESS",
  },
  defaults: {
    locator: "0xC1d0b3DE6792Bf6b4b37EccdcC24e45978Cfd2Eb",
    // https://docs.lido.fi/deployed-contracts/#dao-contracts
    agent: "0x3e40D73EB977Dc6a537aF587D48316feE66E9C8c",
    voting: "0x2e59A20f205bB85a89C53f1936454680651E618e",
    // https://docs.lido.fi/deployed-contracts/#easy-track
    easyTrack: "0xFE5986E06210aC1eCC1aDCafc0cc7f8D63B3F977",
  },
};

/**
 * Map of HardHat networks to the protocol discovery config
 */
export const networks = new Map<string, ProtocolNetworkConfig>([
  ["local", local],
  ["mainnet-fork", mainnet],
  ["hardhat", mainnet],
]);
