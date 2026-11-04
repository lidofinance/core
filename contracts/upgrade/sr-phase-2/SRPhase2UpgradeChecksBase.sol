// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {SRPhase2UpgradeConfig} from "./SRPhase2UpgradeConfig.sol";
import {
    IDualGovernanceTiebreaker
} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2UpgradeChecksBase
/// @notice Shared assertions of the SR phase 2 (LIP-38) upgrade checks.
/// @dev The checks live outside the template to keep each contract below the EIP-170 limit. They are view only
///      and stateless: the template passes its config, and their custom errors bubble up through it.
abstract contract SRPhase2UpgradeChecksBase {
    error InvalidChainId(uint256 actual, uint256 expected);
    error InvalidAddress(bytes32 field, address actual, address expected);
    error InvalidUint(bytes32 field, uint256 actual, uint256 expected);
    error InvalidFlag(bytes32 field, address subject);

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant TW_EXIT_LIMIT_MANAGER_ROLE = keccak256("TW_EXIT_LIMIT_MANAGER_ROLE");
    bytes32 internal constant ADD_WITHDRAWAL_INTENTS_ROLE = keccak256("ADD_WITHDRAWAL_INTENTS_ROLE");
    bytes32 internal constant CLEAR_WITHDRAWAL_INTENTS_ROLE = keccak256("CLEAR_WITHDRAWAL_INTENTS_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE =
        keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXITING_STATUS_ROLE =
        keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
    bytes32 internal constant SUBMIT_REPORT_HASH_ROLE = keccak256("SUBMIT_REPORT_HASH_ROLE");

    /// @dev The StakingRouter implementation is swapped without a reinitializer.
    uint256 internal constant STAKING_ROUTER_CONTRACT_VERSION = 4;

    /// @dev Addresses the vote must leave untouched; checked identically before and after.
    function _assertUnchangedLocatorMembers(SRPhase2UpgradeConfig config, ILidoLocator locator) internal view {
        _assertAddress("locator-staking-router", locator.stakingRouter(), config.STAKING_ROUTER());
        _assertAddress("locator-withdrawal-vault", locator.withdrawalVault(), config.WITHDRAWAL_VAULT());
        _assertAddress("locator-vebo", locator.validatorsExitBusOracle(), config.VALIDATORS_EXIT_BUS_ORACLE());
    }

    function _assertSingleRoleHolder(
        bytes32 field,
        IAccessControlEnumerable acl,
        bytes32 role,
        address holder
    ) internal view {
        _assertUint(field, acl.getRoleMemberCount(role), 1);
        if (!acl.hasRole(role, holder)) revert InvalidFlag(field, holder);
    }

    function _assertTiebreakerBlocker(bytes32 field, address dualGovernance, address sealable, bool expected) internal view {
        address[] memory blockers =
            IDualGovernanceTiebreaker(dualGovernance).getTiebreakerDetails().sealableWithdrawalBlockers;

        bool isBlocker = false;
        for (uint256 i = 0; i < blockers.length; ++i) {
            if (blockers[i] == sealable) {
                isBlocker = true;
                break;
            }
        }

        if (isBlocker != expected) revert InvalidFlag(field, sealable);
    }

    function _assertAddress(bytes32 field, address actual, address expected) internal pure {
        if (actual != expected) revert InvalidAddress(field, actual, expected);
    }

    function _assertUint(bytes32 field, uint256 actual, uint256 expected) internal pure {
        if (actual != expected) revert InvalidUint(field, actual, expected);
    }
}
