// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {StETHPermit} from "contracts/0.4.24/StETHPermit.sol";

contract StETHPermit__HarnessForDashboard is StETHPermit {
    uint256 public totalPooledEther;
    uint256 public totalShares;
    mapping(address => uint256) private shares;

    constructor() public {}

    function _getTotalPooledEther() internal view returns (uint256) {
        return totalPooledEther;
    }

    // Lido::mintShares
    function mintExternalShares(address _recipient, uint256 _sharesAmount) external {
        _mintShares(_recipient, _sharesAmount);

        // StETH::_emitTransferEvents
        emit Transfer(address(0), _recipient, getPooledEthByShares(_sharesAmount));
        emit TransferShares(address(0), _recipient, _sharesAmount);
    }

    // Lido::burnShares
    function burnExternalShares(uint256 _sharesAmount) external {
        _burnShares(msg.sender, _sharesAmount);
    }

    // StETH::_getTotalShares
    function _getTotalShares() internal view returns (uint256) {
        return totalShares;
    }

    // StETH::getSharesByPooledEth
    function getSharesByPooledEth(uint256 _ethAmount) public view returns (uint256) {
        return (_ethAmount * _getTotalShares()) / _getTotalPooledEther();
    }

    // StETH::getPooledEthByShares
    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * _getTotalPooledEther()) / _getTotalShares();
    }

    // Mock functions
    function mock__setTotalPooledEther(uint256 _totalPooledEther) external {
        totalPooledEther = _totalPooledEther;
    }

    function mock__setTotalShares(uint256 _totalShares) external {
        totalShares = _totalShares;
    }

    function mock__getTotalShares() external view returns (uint256) {
        return _getTotalShares();
    }
}
