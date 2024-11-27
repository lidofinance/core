// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.4.24;

import {StETH} from "contracts/0.4.24/StETH.sol";

contract StETH__HarnessForVaultHub is StETH {
    uint256 internal constant TOTAL_BASIS_POINTS = 10000;

    address private mock__minter;
    address private mock__burner;
    bool private mock__shouldUseSuperGuards;

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

    function getMaxExternalEther() external view returns (uint256) {
        return _getTotalPooledEther().mul(maxExternalBalanceBp).div(TOTAL_BASIS_POINTS);
    }

    function _getTotalPooledEther() internal view returns (uint256) {
        return totalPooledEther;
    }

    function setTotalPooledEther(uint256 _totalPooledEther) public {
        totalPooledEther = _totalPooledEther;
    }

    function mock__setMinter(address _minter) public {
        mock__minter = _minter;
    }

    function mock__setBurner(address _burner) public {
        mock__burner = _burner;
    }

    function mock__useSuperGuards(bool _shouldUseSuperGuards) public {
        mock__shouldUseSuperGuards = _shouldUseSuperGuards;
    }

    function _isMinter(address _address) internal view returns (bool) {
        if (mock__shouldUseSuperGuards) {
            return super._isMinter(_address);
        }

        return _address == mock__minter;
    }

    function _isBurner(address _address) internal view returns (bool) {
        if (mock__shouldUseSuperGuards) {
            return super._isBurner(_address);
        }

        return _address == mock__burner;
    }

    function harness__mintInitialShares(uint256 _sharesAmount) public {
        _mintInitialShares(_sharesAmount);
    }
}
