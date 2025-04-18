// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import {TierParams} from "contracts/0.8.25/vaults/OperatorGrid.sol";

contract OperatorGrid__MockForVaultHub {
    struct Tier {
        address operator;
        uint96 shareLimit;
        uint96 liabilityShares;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 treasuryFeeBP;
    }

    Tier[] public tiers;
    mapping(address vault => uint256 tierId) public vaultTier;

    function initialize(uint256 _defaultShareLimit) external {
        tiers.push(Tier(address(1), uint96(_defaultShareLimit), 0, 2000, 1800, 500));
    }

    function changeVaultTierParams(address _vault, TierParams calldata _tierParams) external {
        Tier storage tierParams = tiers[vaultTier[_vault]];
        tierParams.shareLimit = uint96(_tierParams.shareLimit);
        tierParams.reserveRatioBP = uint16(_tierParams.reserveRatioBP);
        tierParams.forcedRebalanceThresholdBP = uint16(_tierParams.forcedRebalanceThresholdBP);
        tierParams.treasuryFeeBP = uint16(_tierParams.treasuryFeeBP);
    }

    function vaultInfo(
        address vaultAddr
    )
        external
        view
        returns (
            uint256 groupId,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 treasuryFeeBP
        )
    {
        Tier memory tierParams = tiers[vaultTier[vaultAddr]];

        groupId = 0;
        tierId = 0;
        shareLimit = tierParams.shareLimit;
        reserveRatioBP = tierParams.reserveRatioBP;
        forcedRebalanceThresholdBP = tierParams.forcedRebalanceThresholdBP;
        treasuryFeeBP = tierParams.treasuryFeeBP;
    }

    function onMintedShares(address vaultAddr, uint256 amount) external {}

    function onBurnedShares(address vaultAddr, uint256 amount) external {}
}
