// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";
import {IPredepositGuarantee} from "contracts/0.8.25/vaults/interfaces/IPredepositGuarantee.sol";
import {ConsolidationGateway} from "contracts/0.8.25/ConsolidationGateway.sol";

/**
 * @dev Test harness that skips CL proof verification for unit tests
 */
contract ConsolidationGateway__HarnessForTests is ConsolidationGateway {
    constructor(
        address admin,
        address lidoLocator,
        uint256 maxConsolidationRequestsLimit,
        uint256 consolidationsPerFrame,
        uint256 frameDurationInSec,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot,
        bytes32 _withdrawalCredentials
    )
        ConsolidationGateway(
            admin,
            lidoLocator,
            maxConsolidationRequestsLimit,
            consolidationsPerFrame,
            frameDurationInSec,
            _gIFirstValidatorPrev,
            _gIFirstValidatorCurr,
            _pivotSlot,
            _withdrawalCredentials
        )
    {}

    function _validateTargetWitness(
        IPredepositGuarantee.ValidatorWitness calldata /* _witness */
    ) internal pure override {
        // no-op: skip CL proof verification in unit tests
    }
}
