// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {TierParams} from "contracts/0.8.25/vaults/OperatorGrid.sol";

contract OperatorGrid__MockForVaultHub {
    mapping(address => TierParams) public vaults;

    function registerVault(address _vault, TierParams calldata _tierParams) external {
        vaults[_vault] = _tierParams;
    }

    function registerVault(address _vault) external {
        vaults[_vault] = TierParams({
            shareLimit: 1 ether,
            reserveRatioBP: 1000,
            rebalanceThresholdBP: 800,
            treasuryFeeBP: 500
        });
    }

    function getVaultInfo(
        address vaultAddr
    )
        external
        view
        returns (
            uint256 groupId,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 rebalanceThresholdBP,
            uint256 treasuryFeeBP
        )
    {
        TierParams memory tierParams = vaults[vaultAddr];

        groupId = 0;
        tierId = 0;
        shareLimit = tierParams.shareLimit;
        reserveRatioBP = tierParams.reserveRatioBP;
        rebalanceThresholdBP = tierParams.rebalanceThresholdBP;
        treasuryFeeBP = tierParams.treasuryFeeBP;
    }

    function onMintedShares(address vaultAddr, uint256 amount) external {}

    function onBurnedShares(address vaultAddr, uint256 amount) external {}
}
