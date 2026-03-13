// SPDX-License-Identifier: MIT
pragma solidity 0.8.25;

import {TopUpGateway} from "contracts/0.8.25/TopUpGateway.sol";
import {GIndex} from "contracts/common/lib/GIndex.sol";
import {BeaconRootData, ValidatorWitness} from "contracts/common/interfaces/TopUpWitness.sol";

contract TopUpGateway__Harness is TopUpGateway {
    constructor(
        address _lidoLocator,
        GIndex _gIFirstValidatorPrev,
        GIndex _gIFirstValidatorCurr,
        uint64 _pivotSlot,
        uint256 _slotsPerEpoch
    ) TopUpGateway(_lidoLocator, _gIFirstValidatorPrev, _gIFirstValidatorCurr, _pivotSlot, _slotsPerEpoch) {}

    function harness_setLastTopUpData() external {
        _setLastTopUpData();
    }

    function harness_setLastTopUpTimestamp(uint256 _timestamp) external {
        _gatewayStorage().lastTopUpTimestamp = uint32(_timestamp);
    }

    function harness_setLastTopUpBlock(uint256 _block) external {
        _gatewayStorage().lastTopUpBlock = uint32(_block);
    }

    function harness_setMaxValidatorsPerTopUp(uint256 newValue) external {
        _setMaxValidatorsPerTopUp(newValue);
    }

    function harness_setMinBlockDistance(uint256 newValue) external {
        _setMinBlockDistance(newValue);
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
