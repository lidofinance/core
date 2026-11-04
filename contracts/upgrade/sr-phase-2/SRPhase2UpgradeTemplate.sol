// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IUpgradeTemplate} from "../interfaces/IUpgradeTemplate.sol";
import {SRPhase2PostUpgradeChecks} from "./SRPhase2PostUpgradeChecks.sol";
import {SRPhase2PreUpgradeChecks} from "./SRPhase2PreUpgradeChecks.sol";
import {SRPhase2UpgradeConfig} from "./SRPhase2UpgradeConfig.sol";
import {SRPhase2UpgradeParameters} from "./SRPhase2UpgradeTypes.sol";

/// @title SRPhase2UpgradeTemplate
/// @notice Pre/post checks wrapping the SR phase 2 (LIP-38) upgrade vote.
/// @dev `startUpgrade` and `finishUpgrade` must run in the same transaction, so the whole vote
///      reverts if the observed state does not match what was deployed. The Dual Governance calls of the vote
///      run between them, so both checks cover the tiebreaker sealable withdrawal blockers too.
///      The checks themselves live in two contracts the constructor creates next to the config, so each
///      contract stays below the EIP-170 limit.
contract SRPhase2UpgradeTemplate is IUpgradeTemplate {
    event UpgradeStarted();
    event UpgradeFinished();

    error OnlyAgentCanUpgrade();
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error Expired();
    error InvalidExpiry();
    error InvalidChainId(uint256 actual, uint256 expected);
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();

    uint256 internal constant UPGRADE_NOT_STARTED = 0;
    // keccak256("SRPhase2UpgradeTemplate.upgradeStartedFlag")
    bytes32 internal constant UPGRADE_STARTED_SLOT = 0x684cb8f14a7fe2a7e8907f7b820c3cc114907b56da53c8cbe2aa6b3695fbf581;

    address public immutable override CONFIG;
    address public immutable PRE_UPGRADE_CHECKS;
    address public immutable POST_UPGRADE_CHECKS;
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public override isUpgradeFinished;

    constructor(SRPhase2UpgradeParameters memory params, uint256 expireSinceInclusive) {
        if (params.chainId != block.chainid) revert InvalidChainId(block.chainid, params.chainId);
        if (expireSinceInclusive <= block.timestamp) revert InvalidExpiry();

        SRPhase2UpgradeConfig config = new SRPhase2UpgradeConfig(params);
        CONFIG = address(config);
        PRE_UPGRADE_CHECKS = address(new SRPhase2PreUpgradeChecks());
        POST_UPGRADE_CHECKS = address(new SRPhase2PostUpgradeChecks());
        EXPIRE_SINCE_INCLUSIVE = expireSinceInclusive;
    }

    function startUpgrade() external {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly {
            tstore(UPGRADE_STARTED_SLOT, 1)
        }
        upgradeBlockNumber = block.number;

        SRPhase2PreUpgradeChecks(PRE_UPGRADE_CHECKS).validate(config);
        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        SRPhase2UpgradeConfig config = SRPhase2UpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;
        SRPhase2PostUpgradeChecks(POST_UPGRADE_CHECKS).validate(config);
        emit UpgradeFinished();
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
    }
}
