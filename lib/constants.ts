export const MAX_UINT256 = 2n ** 256n - 1n;
export const INITIAL_STETH_HOLDER = "0x000000000000000000000000000000000000dEaD";

// https://eips.ethereum.org/EIPS/eip-165
// bytes4(keccak256('supportsInterface(bytes4)'))
export const ERC165_INTERFACE_ID = "0x01ffc9a7";

// XOR of all the method selectors
export const ERC721_INTERFACE_ID = "0x80ac58cd";
export const ERC721METADATA_INTERFACE_ID = "0x5b5e139f";

// 0x49064906 is magic number ERC4906 interfaceId as defined in the standard https://eips.ethereum.org/EIPS/eip-4906
export const ERC4906_INTERFACE_ID = "0x49064906";

// HashConsensus farFutureEpoch:
// (2n ** 64n - 1n - GENESIS_TIME) / SECONDS_PER_SLOT / SLOTS_PER_EPOCH
export const HASH_CONSENSUS_FAR_FUTURE_EPOCH = 48038396021015343n;

// OZ Interfaces
export const OZ_ACCESS_CONTROL_INTERFACE_ID = "0x7965db0b";
export const OZ_ACCESS_CONTROL_ENUMERABLE_INTERFACE_ID = "0x5a05180f";

// special reserved interface id
export const INVALID_INTERFACE_ID = "0xffffffff";

// Chain related
export const SECONDS_PER_SLOT = 12n;
export const EPOCHS_PER_FRAME = 225n; // one day;
export const GENESIS_FORK_VERSION = "0x00000000"; // for mainnet
// Oracle report related
export const GENESIS_TIME = 100n;
export const SLOTS_PER_EPOCH = 32n;
export const BASE_CONSENSUS_VERSION = 1n;
export const AO_CONSENSUS_VERSION = 3n;
export const VEBO_CONSENSUS_VERSION = 2n;
export const INITIAL_EPOCH = 1n;
export const INITIAL_FAST_LANE_LENGTH_SLOTS = 0n;

// Default admin role for AccessControl compatible contracts
export const DEFAULT_ADMIN_ROLE = "0x0000000000000000000000000000000000000000000000000000000000000000";

// Withdrawal Queue related constants
export const WITHDRAWAL_QUEUE_NAME = "Lido: Withdrawal Request NFT";
export const WITHDRAWAL_QUEUE_SYMBOL = "unstETH";
export const WITHDRAWAL_MAX_BATCHES_LENGTH = 36n;

export const WITHDRAWAL_MIN_STETH_WITHDRAWAL_AMOUNT = 100n;
export const WITHDRAWAL_MAX_STETH_WITHDRAWAL_AMOUNT = 10n ** 21n; // 1000 * 1e18

// Validator signing keys related
export const PUBKEY_LENGTH = 48;
export const SIGNATURE_LENGTH = 96;

export const PUBKEY_LENGTH_HEX = PUBKEY_LENGTH * 2;
export const SIGNATURE_LENGTH_HEX = SIGNATURE_LENGTH * 2;
export const EMPTY_PUBLIC_KEY = "0x".padEnd(PUBKEY_LENGTH_HEX + 2, "0");
export const EMPTY_SIGNATURE = "0x".padEnd(SIGNATURE_LENGTH_HEX + 2, "0");

export const ONE_GWEI = 1_000_000_000n;

export const TOTAL_BASIS_POINTS = 100_00n;
export const ABNORMALLY_HIGH_FEE_THRESHOLD_BP = 1_00n;

export const MAX_FEE_BP = 65_535n;

export const MAX_RESERVE_RATIO_BP = 99_99n;
export const LIMITER_PRECISION_BASE = 10n ** 9n;

export const DISCONNECT_NOT_INITIATED = 2n ** 48n - 1n;

// Staking module related
export const MODULE_TYPE_LEGACY = 0;
export const MODULE_TYPE_NEW = 1;

export const WITHDRAWAL_CREDENTIALS_TYPE_01 = 0x01;
export const WITHDRAWAL_CREDENTIALS_TYPE_02 = 0x02;

export enum StakingModuleStatus {
  Active = 0,
  DepositsPaused = 1,
  Stopped = 2,
}

export enum StakingModuleType {
  Legacy = MODULE_TYPE_LEGACY,
  New = MODULE_TYPE_NEW,
}

export enum WithdrawalCredentialsType {
  WC0x01 = WITHDRAWAL_CREDENTIALS_TYPE_01,
  WC0x02 = WITHDRAWAL_CREDENTIALS_TYPE_02,
}

export const getModuleWCType = (moduleType: StakingModuleType): WithdrawalCredentialsType => {
  switch (moduleType) {
    case StakingModuleType.Legacy:
      return WithdrawalCredentialsType.WC0x01;
    case StakingModuleType.New:
      return WithdrawalCredentialsType.WC0x02;
    default: {
      const _exhaustive: never = moduleType;
      return _exhaustive;
    }
  }
};

export const MAX_EFFECTIVE_BALANCE_WC_TYPE_01 = 32n * 10n ** 18n; // 32 ETH
export const MAX_EFFECTIVE_BALANCE_WC_TYPE_02 = 2048n * 10n ** 18n; // 2048 ETH

export const getModuleMEB = (moduleType: StakingModuleType): bigint => {
  switch (moduleType) {
    case StakingModuleType.Legacy:
      return MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
    case StakingModuleType.New:
      return MAX_EFFECTIVE_BALANCE_WC_TYPE_02;
    default: {
      const _exhaustive: never = moduleType;
      return _exhaustive;
    }
  }
};
