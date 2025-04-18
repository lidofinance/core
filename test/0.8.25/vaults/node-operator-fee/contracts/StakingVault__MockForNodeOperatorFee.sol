// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {IStakingVault} from "contracts/0.8.25/vaults/interfaces/IStakingVault.sol";

contract StakingVault__MockForNodeOperatorFee {
    event Mock__Withdrawn(address indexed _sender, address indexed _recipient, uint256 _amount);

    address public immutable vaultHub;
    uint256 public locked;

    IStakingVault.Report public latestReport;

    constructor(address _vaultHub) {
        vaultHub = _vaultHub;
    }

    function setLatestReport(IStakingVault.Report memory _latestReport) external {
        latestReport = _latestReport;
    }

    function setLocked(uint256 _locked) external {
        locked = _locked;
    }

    function totalValue() external view returns (uint256) {
        return latestReport.totalValue;
    }

    function withdraw(address _recipient, uint256 _amount) external {
        emit Mock__Withdrawn(msg.sender, _recipient, _amount);
    }
}
