// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {ILido as IStETH} from "../interfaces/ILido.sol";

library VaultHelpers {
    uint256 internal constant TOTAL_BASIS_POINTS = 10_000;

    /**
     * @notice returns total number of stETH shares that can be minted on the vault with provided valuation and reserveRatio.
     * @dev It does not count shares that is already minted.
     * @param _valuation - vault valuation
     * @param _reserveRatio - reserve ratio of the vault to calculate max mintable shares
     * @param _stETH - stETH contract address
     * @return maxShares - maximum number of shares that can be minted with the provided valuation and reserve ratio
     */
    function getMaxMintableShares(uint256 _valuation, uint256 _reserveRatio, address _stETH) internal view returns (uint256) {
        uint256 maxStETHMinted = (_valuation * (TOTAL_BASIS_POINTS - _reserveRatio)) / TOTAL_BASIS_POINTS;
        return IStETH(_stETH).getSharesByPooledEth(maxStETHMinted);
    }
}
