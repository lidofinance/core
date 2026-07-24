import {
  MAX_EFFECTIVE_BALANCE_WC_TYPE_01,
  MAX_EFFECTIVE_BALANCE_WC_TYPE_02,
  WithdrawalCredentialsType,
} from "./constants";
import { de0x, en0x, randomString } from "./string";

/**
 * Returns the max effective balance for the given withdrawal credentials type
 */
export const wcTypeMaxEB = (withdrawalType: WithdrawalCredentialsType): bigint => {
  switch (withdrawalType) {
    case WithdrawalCredentialsType.WC0x01:
      return MAX_EFFECTIVE_BALANCE_WC_TYPE_01;
    case WithdrawalCredentialsType.WC0x02:
      return MAX_EFFECTIVE_BALANCE_WC_TYPE_02;
    default: {
      const _exhaustive: never = withdrawalType;
      return _exhaustive;
    }
  }
};

/**
 * Generates random Winthdrawal Credentials of type 0x01
 */
export const randomWCType1 = () => {
  return en0x(WithdrawalCredentialsType.WC0x01) + de0x(randomString(31));
};

/**
 * Generates random Winthdrawal Credentials of type 0x02
 */
export const randomWCType2 = () => {
  return en0x(WithdrawalCredentialsType.WC0x02) + de0x(randomString(31));
};
