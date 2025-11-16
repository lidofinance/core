// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {TopUpGateway} from "contracts/0.8.25/TopUpGateway.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {
    BeaconRootData,
    ValidatorWitness,
    BalanceWitness,
    PendingWitness
} from "contracts/common/interfaces/TopUpWitness.sol";

contract TopUpGateway__Harness is TopUpGateway {
    constructor(
        address _admin,
        address _lidoLocator,
        uint256 _maxValidatorsPerTopUp,
        uint256 _minBlockDistance,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        GIndex _gIFirstBalancePrev,
        GIndex _gIFirstBalanceCurr,
        GIndex _gIFirstPendingPrev,
        GIndex _gIFirstPendingCurr,
        uint64 _pivotSlot
    )
        TopUpGateway(
            _admin,
            _lidoLocator,
            _maxValidatorsPerTopUp,
            _minBlockDistance,
            _gIFirstValidatorPrev,
            _gIFirstValidatorCurr,
            _gIFirstBalancePrev,
            _gIFirstBalanceCurr,
            _gIFirstPendingPrev,
            _gIFirstPendingCurr,
            _pivotSlot
        )
    {}

    function harness_setLastTopUpSlot(uint256 newValue) external {
        _setLastTopUpSlot(newValue);
    }

    function harness_setMaxValidatorsPerTopUp(uint256 newValue) external {
        _setMaxValidatorsPerTopUp(newValue);
    }

    function harness_setMinBlockDistance(uint256 newValue) external {
        _setMinBlockDistance(newValue);
    }

    function harness_getMaxValidatorsPerTopUp() external view returns (uint256) {
        return maxValidatorsPerTopUp();
    }

    function harness_getMinBlockDistance() external view returns (uint256) {
        return minBlockDistance();
    }

    function harness_getLocator() external view returns (address) {
        return address(LOCATOR);
    }

    function _verifyValidatorWCActiveAndBalance(
        BeaconRootData calldata,
        ValidatorWitness calldata,
        BalanceWitness calldata,
        PendingWitness[] calldata,
        uint256,
        bytes32
    ) internal view override {
        // no-op for harness; verification is covered separately
    }
}
