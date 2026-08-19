// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity 0.8.9;

/// @notice Minimal contract used to verify `addObserver` rejects observers that don't support
///         ERC165 / either pusher interface. Has no `supportsInterface` function at all.
contract NoInterface__Mock {
    uint256 public dummy;

    function setDummy(uint256 value) external {
        dummy = value;
    }
}
