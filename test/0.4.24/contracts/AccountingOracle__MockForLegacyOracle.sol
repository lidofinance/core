// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.4.24 <0.9.0;

import { AccountingOracle, IReportReceiver } from "contracts/0.8.9/oracle/AccountingOracle.sol";
import { ReportValues } from "contracts/0.8.9/Accounting.sol";

interface ITimeProvider {
    function getTime() external view returns (uint256);
}

contract AccountingOracle__MockForLegacyOracle {
    address public immutable LIDO;
    address public immutable CONSENSUS_CONTRACT;
    uint256 public immutable SECONDS_PER_SLOT;

    uint256 internal _lastRefSlot;

    constructor(address lido, address consensusContract, uint256 secondsPerSlot) {
        LIDO = lido;
        CONSENSUS_CONTRACT = consensusContract;
        SECONDS_PER_SLOT = secondsPerSlot;
    }

    function getTime() external view returns (uint256) {
        return _getTime();
    }

    function _getTime() internal view returns (uint256) {
        return ITimeProvider(CONSENSUS_CONTRACT).getTime();
    }

    function submitReportData(AccountingOracle.ReportData calldata data, uint256 /* contractVersion */) external {
        require(data.refSlot >= _lastRefSlot, "refSlot less than _lastRefSlot");
        uint256 slotsElapsed = data.refSlot - _lastRefSlot;
        _lastRefSlot = data.refSlot;

        IReportReceiver(LIDO).handleOracleReport(ReportValues(
            data.refSlot * SECONDS_PER_SLOT,
            slotsElapsed * SECONDS_PER_SLOT,
            data.numValidators,
            data.clBalanceGwei * 1e9,
            data.withdrawalVaultBalance,
            data.elRewardsVaultBalance,
            data.sharesRequestedToBurn,
            data.withdrawalFinalizationBatches,
            new uint256[](0),
            new int256[](0)
            )
        );
    }

    function getLastProcessingRefSlot() external view returns (uint256) {
        return _lastRefSlot;
    }

    function getConsensusContract() external view returns (address) {
        return CONSENSUS_CONTRACT;
    }
}
