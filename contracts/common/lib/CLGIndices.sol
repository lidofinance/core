// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {GIndex} from "contracts/common/lib/GIndex.sol";

library CLGIndices {
    // Pre-Gloas (Electra) CL state layout. There is a single supported fork before Gloas,
    // so these indices are fixed for every Lido deployment.
    GIndex internal constant FIRST_VALIDATOR_PRE_GLOAS =
        GIndex.wrap(0x0000000000000000000000000000000000000000000000000096000000000028);
    GIndex internal constant FIRST_HISTORICAL_SUMMARY_PRE_GLOAS =
        GIndex.wrap(0x000000000000000000000000000000000000000000000000000000b600000018);

    // Gloas CL state layout.
    GIndex internal constant VALIDATORS =
        GIndex.wrap(0x0000000000000000000000000000000000000000000000000000000000016600);
    GIndex internal constant FIRST_HISTORICAL_SUMMARY =
        GIndex.wrap(0x0000000000000000000000000000000000000000000000000000170c00000018);
}
