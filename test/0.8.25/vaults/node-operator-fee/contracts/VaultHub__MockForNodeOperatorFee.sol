// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StETH__MockForNodeOperatorFee} from "./StETH__MockForNodeOperatorFee.sol";

contract VaultHub__MockForNodeOperatorFee {
    uint256 public constant CONNECT_DEPOSIT = 1 ether;
    uint256 public constant REPORT_FRESHNESS_DELTA = 2 days;

    address public immutable LIDO_LOCATOR;
    StETH__MockForNodeOperatorFee public immutable steth;

    VaultHub.Report public latestVaultReport;
    bool public isVaultReportFresh;

    event Mock__Withdrawn(address vault, address recipient, uint256 amount);

    constructor(address _lidoLocator, StETH__MockForNodeOperatorFee _steth) {
        LIDO_LOCATOR = _lidoLocator;
        steth = _steth;
    }

    event Mock__VaultDisconnectInitiated(address vault);
    event Mock__Rebalanced(uint256 amount);
    event Mock__VaultConnected(address vault);

    function setReport(VaultHub.Report calldata _report, bool _isReportFresh) external {
        latestVaultReport = _report;
        if (_report.timestamp == 0) {
            latestVaultReport.timestamp = uint32(block.timestamp);
        }
        isVaultReportFresh = _isReportFresh;
    }

    function latestReport(address) external view returns (VaultHub.Report memory) {
        return latestVaultReport;
    }

    function isReportFresh(address) external view returns (bool) {
        return isVaultReportFresh;
    }

    function connectVault(address vault) external {
        emit Mock__VaultConnected(vault);
    }

    function disconnect(address vault) external {
        emit Mock__VaultDisconnectInitiated(vault);
    }

    function mintShares(address /* vault */, address recipient, uint256 amount) external {
        steth.mint(recipient, amount);
    }

    function burnShares(address /* vault */, uint256 amount) external {
        steth.burn(amount);
    }

    function voluntaryDisconnect(address _vault) external {
        emit Mock__VaultDisconnectInitiated(_vault);
    }

    function rebalance() external payable {
        emit Mock__Rebalanced(msg.value);
    }

    function withdraw(address _vault, address _recipient, uint256 _amount) external {
        emit Mock__Withdrawn(_vault, _recipient, _amount);
    }
}
