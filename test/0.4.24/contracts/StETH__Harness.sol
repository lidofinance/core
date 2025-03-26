// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {StETH} from "contracts/0.4.24/StETH.sol";

contract StETH__Harness is StETH {
    uint256 private totalPooledEther;

    constructor(address _holder) public payable {
        _resume();
        uint256 balance = address(this).balance;
        assert(balance != 0);

        setTotalPooledEther(balance);
        _mintShares(_holder, balance);
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

    function harness__mintShares(address _recipient, uint256 _sharesAmount) public {
        _mintShares(_recipient, _sharesAmount);
    }

    function burnShares(uint256 _amount) external {
        _burnShares(msg.sender, _amount);
    }
}
