// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {StETH} from "contracts/0.4.24/StETH.sol";

contract StETH__HarnessForVaultHub is StETH {
    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    uint256 private totalPooledEther;
    uint256 private externalBalance;
    uint256 private maxExternalBalanceBp = 100; //bp

    constructor(address _holder) public payable {
        _resume();
        uint256 balance = address(this).balance;
        assert(balance != 0);

        setTotalPooledEther(balance);
        _mintShares(_holder, balance);
    }

    function getExternalEther() external view returns (uint256) {
        return externalBalance;
    }

    // This is simplified version of the function for testing purposes
    function getMaxAvailableExternalBalance() external view returns (uint256) {
        return _getTotalPooledEther().mul(maxExternalBalanceBp).div(TOTAL_BASIS_POINTS);
    }

    function _getTotalPooledEther() internal view returns (uint256) {
        return totalPooledEther;
    }

    function setTotalPooledEther(uint256 _totalPooledEther) public {
        totalPooledEther = _totalPooledEther;
    }

    function harness__mintInitialShares(uint256 _sharesAmount) public {
        _mintInitialShares(_sharesAmount);
    }

    function mintExternalShares(address _recipient, uint256 _sharesAmount) public {
        _mintShares(_recipient, _sharesAmount);
    }

    function rebalanceExternalEtherToInternal() public payable {
        require(msg.value != 0, "ZERO_VALUE");

        totalPooledEther += msg.value;
        externalBalance -= msg.value;
    }

    function burnExternalShares(uint256 _sharesAmount) public {
        _burnShares(msg.sender, _sharesAmount);
    }
}
