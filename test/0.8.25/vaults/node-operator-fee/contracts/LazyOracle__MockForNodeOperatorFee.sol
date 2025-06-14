// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {ILazyOracle} from "contracts/common/interfaces/ILazyOracle.sol";

contract LazyOracle__MockForNodeOperatorFee is ILazyOracle {
    QuarantineInfo internal quarantineInfo;

    function updateReportData(
        uint256 _timestamp,
        bytes32 _vaultsDataTreeRoot,
        string memory _vaultsDataReportCid
    ) external {}

    function mock__setQuarantineInfo(QuarantineInfo memory _quarantineInfo) external {
        quarantineInfo = _quarantineInfo;
    }

    function vaultQuarantine(address _vault) external view returns (QuarantineInfo memory) {
        return quarantineInfo;
    }
}
