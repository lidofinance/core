// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido as IStETH} from "contracts/0.8.25/interfaces/ILido.sol";

contract VaultHub__Harness is VaultHub {
    constructor(
        address _locator,
        uint256 _connectedVaultsLimit,
        uint256 _relativeShareLimitBP
    )
        VaultHub(
            ILidoLocator(_locator),
            ILidoLocator(_locator).lido(),
            ILidoLocator(_locator).accounting(),
            _connectedVaultsLimit,
            _relativeShareLimitBP
        )
    {}

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
            calculateVaultsRebase(
                _postTotalShares,
                _postTotalPooledEther,
                _preTotalShares,
                _preTotalPooledEther,
                _sharesToMintAsFees
            );
    }
}
