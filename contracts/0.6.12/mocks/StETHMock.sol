// SPDX-License-Identifier: NONE

pragma solidity 0.6.12; // latest available for using OZ

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20Burnable.sol";


contract StETHMock is ERC20, ERC20Burnable {
    constructor() public ERC20("Liquid staked Lido Ether", "StETH") {}

    uint256 public totalShares;
    uint256 public totalPooledEther;

    function mint(address recipient, uint256 amount) public {
        _mint(recipient, amount);
    }

    function slash(address holder, uint256 amount) public {
        _burn(holder, amount);
    }

    function setTotalShares(uint256 _totalShares) public {
        totalShares = _totalShares;
    }

    function setTotalPooledEther(uint256 _totalPooledEther) public {
        totalPooledEther = _totalPooledEther;
    }

    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        if (totalShares == 0)
            return 0;
        return _sharesAmount.mul(totalPooledEther).div(totalShares);
    }

    function getSharesByPooledEth(uint256 _pooledEthAmount) public view returns (uint256) {
        if (totalPooledEther == 0)
            return 0;
        return _pooledEthAmount.mul(totalShares).div(totalPooledEther);
    }
}
