// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.9;

import { SanityFuse } from "../../../contracts/0.8.9/sanity_checks/SanityFuse.sol";

contract SanityFuseWrapper is SanityFuse {

    bytes32 public constant MANAGE_MEMBERS_AND_QUORUM_ROLE =
        keccak256("MANAGE_MEMBERS_AND_QUORUM_ROLE");

    constructor(address fuseCommittee, uint256 expiryTimestamp)
        SanityFuse(fuseCommittee, expiryTimestamp) {}

    function consultFuseWrapper(bool succussfulReport) external returns (bool) {
        return consultFuse(succussfulReport);
    }

}
