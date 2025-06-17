// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

import {TierParams} from "contracts/0.8.25/vaults/OperatorGrid.sol";

contract OperatorGrid__MockForVaultHub {
    uint256 public constant DEFAULT_TIER_ID = 0;

    struct Tier {
        address operator;
        uint96 shareLimit;
        uint96 liabilityShares;
        uint16 reserveRatioBP;
        uint16 forcedRebalanceThresholdBP;
        uint16 infraFeeBP;
        uint16 liquidityFeeBP;
        uint16 reservationFeeBP;
    }

    Tier[] public tiers;
    mapping(address vault => uint256 tierId) public vaultTier;

    function initialize(uint256 _defaultShareLimit) external {
        tiers.push(Tier(address(1), uint96(_defaultShareLimit), 0, 2000, 1800, 500, 100, 100));
    }

    function changeVaultTierParams(address _vault, TierParams calldata _tierParams) external {
        Tier storage tierParams = tiers[vaultTier[_vault]];
        tierParams.shareLimit = uint96(_tierParams.shareLimit);
        tierParams.reserveRatioBP = uint16(_tierParams.reserveRatioBP);
        tierParams.forcedRebalanceThresholdBP = uint16(_tierParams.forcedRebalanceThresholdBP);
        tierParams.infraFeeBP = uint16(_tierParams.infraFeeBP);
        tierParams.liquidityFeeBP = uint16(_tierParams.liquidityFeeBP);
        tierParams.reservationFeeBP = uint16(_tierParams.reservationFeeBP);
    }

    function vaultInfo(
        address _vault
    )
        external
        view
        returns (
            uint256 groupId,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 infraFeeBP,
            uint256 liquidityFeeBP,
            uint256 reservationFeeBP
        )
    {
        Tier memory tierParams = tiers[vaultTier[_vault]];

        groupId = 0;
        tierId = 0;
        shareLimit = tierParams.shareLimit;
        reserveRatioBP = tierParams.reserveRatioBP;
        forcedRebalanceThresholdBP = tierParams.forcedRebalanceThresholdBP;
        infraFeeBP = tierParams.infraFeeBP;
        liquidityFeeBP = tierParams.liquidityFeeBP;
        reservationFeeBP = tierParams.reservationFeeBP;
    }

    function resetVaultTier(address _vault) external {
        emit TierChanged(_vault, DEFAULT_TIER_ID);
    }

    function onMintedShares(address vault, uint256 amount) external {}

    function onBurnedShares(address vault, uint256 amount) external {}

    event TierChanged(address vault, uint256 indexed tierId);
}
