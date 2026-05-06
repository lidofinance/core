// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {SRStorage} from "./SRStorage.sol";
import {ModuleState} from "./SRTypes.sol";
import {ISRBase} from "./ISRBase.sol";
import {WithdrawalCredentials} from "contracts/common/lib/WithdrawalCredentials.sol";

/**
 * @title StakingRouter utility functions
 * @author KRogLA
 */
library SRUtils {
    using SRStorage for ModuleState;
    using SRStorage for uint256; // for module IDs

    uint256 public constant TOTAL_BASIS_POINTS = 10000;
    uint256 public constant MAX_STAKING_MODULES_COUNT = 32;
    /// @dev Restrict the name size with 31 bytes to storage in a single slot.
    uint256 public constant MAX_STAKING_MODULE_NAME_LENGTH = 31;

    /// @dev Large enough to fit all existing Ether per entity, yet overflow-safe when aggregating a reasonable number of entities
    uint256 internal constant MAX_VALUE_GWEI = 1_000_000_000 ether / 1 gwei; // i.e. 1B ETH

    /**
     * Validation
     */

    function _requireNotZero(uint256 _value) internal pure {
        if (_value == 0) revert ISRBase.ZeroArgument();
    }

    function _requireNotZero(address _address) internal pure {
        if (_address == address(0)) revert ISRBase.ZeroAddress();
    }

    function _requireWCTypeValid(uint256 _wcType) internal pure {
        if (!WithdrawalCredentials.isTypeValid(_wcType)) revert ISRBase.WrongWithdrawalCredentialsType();
    }

    function _requireWCType2(uint256 _wcType) internal pure {
        if (!WithdrawalCredentials.isType2(_wcType)) revert ISRBase.WrongWithdrawalCredentialsType();
    }

    function _requireModuleIdExists(uint256 _moduleId) internal view {
        if (!SRStorage.isModuleExists(_moduleId)) revert ISRBase.StakingModuleUnregistered();
    }

    /**
     * Module helpers
     */

    /// @dev will cause an overflow error if moduleId does not exist
    /// @param moduleId module id
    /// @return module index in the list of modules (0-based)
    function _getModuleIndexById(uint256 moduleId) internal view returns (uint256) {
        /// @dev convert from 1-based position
        return SRStorage.getModuleIdInnerPosition(moduleId) - 1;
    }

    /// @dev get validators (active) balance of the module in ETH (wei)
    function _getModuleValidatorsBalance(uint256 moduleId) internal view returns (uint256) {
        return _fromGwei(moduleId.getModuleState().accounting.validatorsBalanceGwei);
    }

    ///  @dev get total validators (active) balance of all modules in ETH
    function _getTotalModulesValidatorsBalance() internal view returns (uint256) {
        return _fromGwei(SRStorage.getRouterState().accounting.validatorsBalanceGwei);
    }

    /**
     * Amount helpers
     */

    /// @dev checks if the amount not exceeds a reasonable limit and converts it to uint64
    /// @param amountGwei checked amount in gwei
    /// @return validated amount in gwei as uint64
    function _ensureAmountGwei(uint256 amountGwei) internal pure returns (uint64) {
        if (amountGwei > MAX_VALUE_GWEI) {
            revert ISRBase.InvalidAmountGwei();
        }
        return uint64(amountGwei);
    }

    /// @dev converts amount from wei to gwei
    function _toGwei(uint256 amount) internal pure returns (uint64) {
        return _ensureAmountGwei(amount / 1 gwei);
    }

    /// @dev converts amount from gwei to wei
    /// @dev skip _ensureAmountGwei for the input amount due to using the method only as a reverse
    ///      conversion to values saved via _toGwei
    function _fromGwei(uint256 amount) internal pure returns (uint256) {
        return amount * 1 gwei;
    }
}
