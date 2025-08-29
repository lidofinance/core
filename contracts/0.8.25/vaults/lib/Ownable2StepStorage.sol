// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

library Ownable2StepStorage {
    struct Storage {
        address owner;
        address pendingOwner;
    }

    // keccak256(abi.encode(uint256(keccak256("lido.storage.Ownable2Step")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_OFFSET = 0xfd1d63a705c5e81d4a0c80ad99cdd4faa9dc068f77c4225797b0af6e550e9300;

    function owner() internal view returns (address) {
        return _storage().owner;
    }

    function pendingOwner() internal view returns (address) {
        return _storage().pendingOwner;
    }

    function checkOwner() internal view {
        if (msg.sender != owner()) revert SenderNotOwner();
    }

    function checkPendingOwner() internal view {
        if (msg.sender != pendingOwner()) revert SenderNotPendingOwner();
    }

    function setOwner(address newOwner) internal {
        checkOwner();

        address previousOwner = _storage().owner;
        _storage().owner = newOwner;

        emit OwnerSet(previousOwner, newOwner);
    }

    function setPendingOwner(address newPendingOwner) internal {
        checkOwner();

        _storage().pendingOwner = newPendingOwner;

        emit PendingOwnerSet(newPendingOwner);
    }

    function _storage() private pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_OFFSET
        }
    }

    event OwnerSet(address previousOwner, address newOwner);
    event PendingOwnerSet(address newPendingOwner);

    error SenderNotOwner();
    error SenderNotPendingOwner();
}
