export const SEPOLIA_CHAIN_ID = 11155111;

// Real Sepolia beacon deposit contract — a BEPOLIA-gated variant of
// https://github.com/protolambda/testnet-dep-contract — that Lido wraps with
// SepoliaDepositAdapter to expose a mainnet-style IDepositContract.
export const SEPOLIA_ORIGINAL_DEPOSIT_CONTRACT = "0x7f02C3E3c98b133055B8B348B2Ac625669Ed295D";

// Known BEPOLIA-rich holder used to top up the adapter in tests on Sepolia forks.
export const SEPOLIA_BEPOLIA_WHALE = "0xf97e180c050e5Ab072211Ad2C213Eb5AEE4DF134";
