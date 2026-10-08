// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";

/// @notice Generalized indices and list depths of the `BeaconState` fields the verifiers build proofs against.
/// @dev The indices point to the field roots. The tree shapes below the fields are fork-dependent,
///      so the verifiers concatenate the node indices themselves, see `_getValidatorGI` and the alike.
library CLGIndices {
    // Pre-Gloas (Electra) CL state layout. There is a single supported fork before Gloas,
    // so these indices are fixed for every Lido deployment.

    /// @dev `BeaconState.validators`.
    GIndex internal constant VALIDATORS_PRE_GLOAS = GIndex.wrap(0x4b);
    /// @dev Depth of the pre-Gloas `BeaconState.validators` list, log2(VALIDATOR_REGISTRY_LIMIT).
    uint256 internal constant VALIDATORS_DEPTH_PRE_GLOAS = 40;
    /// @dev `BeaconState.historical_summaries`.
    GIndex internal constant HISTORICAL_SUMMARIES_PRE_GLOAS = GIndex.wrap(0x5b);
    /// @dev Depth of the `BeaconState.historical_summaries` list, log2(HISTORICAL_ROOTS_LIMIT).
    ///      The list remains static across forks.
    uint256 internal constant HISTORICAL_SUMMARIES_DEPTH = 24;

    // Gloas CL state layout.

    /// @dev `BeaconState.validators`.
    GIndex internal constant VALIDATORS = GIndex.wrap(0x166);
    /// @dev `BeaconState.historical_summaries`.
    GIndex internal constant HISTORICAL_SUMMARIES = GIndex.wrap(0xb86);

    /// @dev `HistoricalSummary.block_summary_root`, the block roots vector root.
    ///      `HistoricalSummary` is a plain container whose layout does not vary across forks.
    GIndex internal constant BLOCK_ROOT_IN_SUMMARY = GIndex.wrap(2);
}
