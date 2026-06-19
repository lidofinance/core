// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {OperatorGrid, TierParams} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

/// @title OperatorGridHarness
/// @notice Thin wrapper around production OperatorGrid that exposes a `vaultInfo`
///         convenience view used by invariant checks.
///         All business logic (changeTier, registerGroup, etc.) comes from production.
///         changeTier requires dual confirmation — handler must call it from both
///         vault owner and node operator.
contract OperatorGridHarness is OperatorGrid {
    /// @dev Same slot as production OperatorGrid (private constant, so we redeclare).
    ///      keccak256(abi.encode(uint256(keccak256("Lido.Vaults.OperatorGrid")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant _STORAGE_LOCATION = 0x6b64617c951381e2c1eff2be939fe368ab6d76b7d335df2e47ba2309eba1c700;

    constructor(ILidoLocator _locator) OperatorGrid(_locator) {}

    /// @notice Returns vault tier info — convenience view for invariant checks.
    function vaultInfo(
        address _vault
    )
        external
        view
        returns (
            address nodeOperator,
            uint256 tierId,
            uint256 shareLimit,
            uint256 reserveRatioBP,
            uint256 forcedRebalanceThresholdBP,
            uint256 infraFeeBP,
            uint256 liquidityFeeBP,
            uint256 reservationFeeBP
        )
    {
        ERC7201Storage storage $ = _getHarnessStorage();

        tierId = $.vaultTier[_vault];
        Tier memory t = $.tiers[tierId];

        nodeOperator = t.operator;
        shareLimit = t.shareLimit;
        reserveRatioBP = t.reserveRatioBP;
        forcedRebalanceThresholdBP = t.forcedRebalanceThresholdBP;
        infraFeeBP = t.infraFeeBP;
        liquidityFeeBP = t.liquidityFeeBP;
        reservationFeeBP = t.reservationFeeBP;
    }

    function _getHarnessStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := _STORAGE_LOCATION
        }
    }
}
