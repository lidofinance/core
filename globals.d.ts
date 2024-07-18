declare namespace NodeJS {
  export interface ProcessEnv {
    /* for local development and testing */
    LOCAL_RPC_URL: string;
    LOCAL_LOCATOR_ADDRESS: string;
    LOCAL_AGENT_ADDRESS: string;
    LOCAL_VOTING_ADDRESS: string;
    LOCAL_EASY_TRACK_EXECUTOR_ADDRESS: string;

    /* for mainnet testing */
    MAINNET_RPC_URL: string;
    MAINNET_LOCATOR_ADDRESS: string;
    MAINNET_AGENT_ADDRESS: string;
    MAINNET_VOTING_ADDRESS: string;
    MAINNET_EASY_TRACK_EXECUTOR_ADDRESS: string;

    HARDHAT_FORKING_URL?: string;
  }
}
