// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

interface IValidatorsExitBus {
    function getDeliveryTimestamp(bytes32 exitRequestsHash) external view returns (uint256 timestamp);

    function unpackExitRequest(
        bytes calldata exitRequests,
        uint256 dataFormat,
        uint256 index
    ) external view returns (bytes memory pubkey, uint256 nodeOpId, uint256 moduleId, uint256 valIndex);
}
