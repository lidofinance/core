declare namespace NodeJS {
  export interface ProcessEnv {
    /* internal logging verbosity (used in scratch deploy / integration tests) */
    LOG_LEVEL?: "all" | "debug" | "info" | "warn" | "error" | "none"; // default: "info"

    /**
     * Flags for changing the behavior of the Hardhat Network
     */

    /* Test execution mode: 'scratch' for fresh network, 'fork' for forked network */
    MODE?: "scratch" | "forking"; // default: "scratch"

    /* URL of the network to fork from */
    FORK_RPC_URL?: string; // default: "https://eth.drpc.org"

    /**
     * Flags for changing the behavior of the integration tests
     */

    /* if "on" the integration tests will assume CSM module is present in the StakingRouter, and adjust accordingly */
    INTEGRATION_WITH_CSM?: "on" | "off"; // default: "off"

    /* if set, the integration tests will update the share rate to make it dynamic */
    INTEGRATION_DYNAMIC_SHARE_RATE?: "true" | "false"; // default: "false"

    /* if set, the integration tests will burn this number of shares (* 10^18) to make the share rate odd */
    INTEGRATION_SHARES_TO_BURN?: number; // default: null

    /**
     * Network configuration for the protocol discovery.
     */

    /* for local development */
    LOCAL_RPC_URL: string;
    LOCAL_LOCATOR_ADDRESS: string;
    LOCAL_AGENT_ADDRESS: string;
    LOCAL_VOTING_ADDRESS: string;
    LOCAL_EASY_TRACK_EXECUTOR_ADDRESS: string;
    LOCAL_ACCOUNTING_ORACLE_ADDRESS?: string;
    LOCAL_ACL_ADDRESS?: string;
    LOCAL_BURNER_ADDRESS?: string;
    LOCAL_DEPOSIT_SECURITY_MODULE_ADDRESS?: string;
    LOCAL_EL_REWARDS_VAULT_ADDRESS?: string;
    LOCAL_HASH_CONSENSUS_ADDRESS?: string;
    LOCAL_KERNEL_ADDRESS?: string;
    LOCAL_LEGACY_ORACLE_ADDRESS?: string;
    LOCAL_LIDO_ADDRESS?: string;
    LOCAL_WSTETH_ADDRESS?: string;
    LOCAL_NOR_ADDRESS?: string;
    LOCAL_ORACLE_DAEMON_CONFIG_ADDRESS?: string;
    LOCAL_ORACLE_REPORT_SANITY_CHECKER_ADDRESS?: string;
    LOCAL_SDVT_ADDRESS?: string;
    LOCAL_STAKING_ROUTER_ADDRESS?: string;
    LOCAL_VALIDATOR_EXIT_DELAY_VERIFIER_ADDRESS?: string;
    LOCAL_VALIDATORS_EXIT_BUS_ORACLE_ADDRESS?: string;
    LOCAL_WITHDRAWAL_QUEUE_ADDRESS?: string;
    LOCAL_WITHDRAWAL_VAULT_ADDRESS?: string;
    LOCAL_STAKING_VAULT_FACTORY_ADDRESS?: string;

    /* for mainnet fork testing */
    MAINNET_LOCATOR_ADDRESS: string;
    MAINNET_AGENT_ADDRESS: string;
    MAINNET_VOTING_ADDRESS: string;
    MAINNET_EASY_TRACK_EXECUTOR_ADDRESS: string;
    MAINNET_ACCOUNTING_ORACLE_ADDRESS?: string;
    MAINNET_ACL_ADDRESS?: string;
    MAINNET_BURNER_ADDRESS?: string;
    MAINNET_DEPOSIT_SECURITY_MODULE_ADDRESS?: string;
    MAINNET_EL_REWARDS_VAULT_ADDRESS?: string;
    MAINNET_HASH_CONSENSUS_ADDRESS?: string;
    MAINNET_KERNEL_ADDRESS?: string;
    MAINNET_LEGACY_ORACLE_ADDRESS?: string;
    MAINNET_LIDO_ADDRESS?: string;
    MAINNET_WSTETH_ADDRESS?: string;
    MAINNET_NOR_ADDRESS?: string;
    MAINNET_ORACLE_DAEMON_CONFIG_ADDRESS?: string;
    MAINNET_ORACLE_REPORT_SANITY_CHECKER_ADDRESS?: string;
    MAINNET_SDVT_ADDRESS?: string;
    MAINNET_STAKING_ROUTER_ADDRESS?: string;
    MAINNET_VALIDATORS_EXIT_BUS_ORACLE_ADDRESS?: string;
    MAINNET_WITHDRAWAL_QUEUE_ADDRESS?: string;
    MAINNET_WITHDRAWAL_VAULT_ADDRESS?: string;
    MAINNET_STAKING_VAULT_FACTORY_ADDRESS?: string;

    SEPOLIA_RPC_URL?: string;
    HOODI_RPC_URL?: string;

    /* for contract sourcecode verification with `hardhat-verify` */
    ETHERSCAN_API_KEY?: string;

    /* for local devnet */
    LOCAL_DEVNET_PK?: string;
    LOCAL_DEVNET_CHAIN_ID?: string;
    LOCAL_DEVNET_EXPLORER_API_URL?: string;
    LOCAL_DEVNET_EXPLORER_URL?: string;

    /* scratch deploy environment variables */
    NETWORK_STATE_FILE?: string;

    /* hardhat plugins options */
    SKIP_CONTRACT_SIZE?: boolean;
    SKIP_GAS_REPORT?: boolean;
    SKIP_INTERFACES_CHECK?: boolean;

    /* mocka parameters */
    COVERAGE?: string;
  }
}
