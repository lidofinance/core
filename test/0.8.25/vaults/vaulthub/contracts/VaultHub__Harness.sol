// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {Accounting} from "contracts/0.8.25/Accounting.sol";

import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

contract VaultHub__Harness is Accounting {
    constructor(address _locator, address _steth) Accounting(ILidoLocator(_locator), ILido(_steth)) {}

    function mock__calculateVaultsRebase(
        uint256 _postTotalShares,
        uint256 _postTotalPooledEther,
        uint256 _preTotalShares,
        uint256 _preTotalPooledEther,
        uint256 _sharesToMintAsFees
    )
        external
        view
        returns (uint256[] memory lockedEther, uint256[] memory treasuryFeeShares, uint256 totalTreasuryFeeShares)
    {
        return
            _calculateVaultsRebase(
                _postTotalShares,
                _postTotalPooledEther,
                _preTotalShares,
                _preTotalPooledEther,
                _sharesToMintAsFees
            );
    }
}
