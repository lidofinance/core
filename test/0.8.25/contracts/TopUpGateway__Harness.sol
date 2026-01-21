// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {TopUpGateway} from "contracts/0.8.25/TopUpGateway.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {BeaconRootData, ValidatorWitness} from "contracts/common/interfaces/TopUpWitness.sol";

contract TopUpGateway__Harness is TopUpGateway {
    constructor(
        address _admin,
        address _lidoLocator,
        uint256 _maxValidatorsPerTopUp,
        uint256 _minBlockDistance,
        uint256 _maxRootAge,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot
    )
        TopUpGateway(
            _admin,
            _lidoLocator,
            _maxValidatorsPerTopUp,
            _minBlockDistance,
            _maxRootAge,
            _gIFirstValidatorPrev,
            _gIFirstValidatorCurr,
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
        return getMaxValidatorsPerTopUp();
    }

    function harness_getMinBlockDistance() external view returns (uint256) {
        return getMinBlockDistance();
    }

    function harness_getLocator() external view returns (address) {
        return address(LOCATOR);
    }

    function _verifyValidator(
        BeaconRootData calldata,
        ValidatorWitness calldata,
        uint256,
        bytes32
    ) internal view override {
        // no-op for harness; verification is covered separately
    }
}
