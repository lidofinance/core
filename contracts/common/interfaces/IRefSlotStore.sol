// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.8.9;

interface IRefSlotStore {
    function set(bytes32 slot, uint104 value) external;

    function getValue(bytes32 slot) external view returns (uint256);

    function getSnapshotValue(bytes32 slot) external view returns (uint256);

    function reset(bytes32 slot) external;
}
