// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import { ERC20 } from "@openzeppelin/contracts-v5.0.2/token/ERC20/ERC20.sol";

contract StETH__MockForDashboard is ERC20 {
    uint256 public totalPooledEther;
    uint256 public totalShares;
    mapping(address => uint256) private shares;

    constructor(string memory name, string memory symbol) ERC20(name, symbol) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }

    // StETH::_getTotalShares
    function _getTotalShares() internal view returns (uint256) {
        return totalShares;
    }

    // StETH::getSharesByPooledEth
    function getSharesByPooledEth(uint256 _ethAmount) public view returns (uint256) {
        return (_ethAmount * _getTotalShares()) / totalPooledEther;
    }

    // StETH::getPooledEthByShares
    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * totalPooledEther) / _getTotalShares();
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



