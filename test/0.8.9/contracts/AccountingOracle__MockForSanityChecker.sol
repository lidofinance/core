// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity >=0.4.24 <0.9.0;

import {AccountingOracle, ILido} from "contracts/0.8.9/oracle/AccountingOracle.sol";

interface ITimeProvider {
    function getTime() external view returns (uint256);
}

contract AccountingOracle__MockForSanityChecker {
    address public immutable LIDO;
    uint256 public immutable SECONDS_PER_SLOT;
    uint256 public immutable GENESIS_TIME;

    uint256 internal _lastRefSlot;

    constructor(address lido, uint256 secondsPerSlot, uint256 genesisTime) {
        LIDO = lido;
        SECONDS_PER_SLOT = secondsPerSlot;
        GENESIS_TIME = genesisTime;
    }

    function submitReportData(
        AccountingOracle.ReportData calldata data,
        uint256 /* contractVersion */
    ) external {
        require(data.refSlot >= _lastRefSlot, "refSlot less than _lastRefSlot");
        uint256 slotsElapsed = data.refSlot - _lastRefSlot;
        _lastRefSlot = data.refSlot;

        ILido(LIDO).handleOracleReport(
            data.refSlot * SECONDS_PER_SLOT,
            slotsElapsed * SECONDS_PER_SLOT,
            data.numValidators,
            data.clBalanceGwei * 1e9,
            data.withdrawalVaultBalance,
            data.elRewardsVaultBalance,
            data.sharesRequestedToBurn,
            data.withdrawalFinalizationBatches,
            data.simulatedShareRate
        );
    }

    function setLastProcessingRefSlot(uint256 refSlot) external {
        _lastRefSlot = refSlot;
    }

    function getLastProcessingRefSlot() external view returns (uint256) {
        return _lastRefSlot;
    }
}
