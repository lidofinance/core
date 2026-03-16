// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

/// @notice Minimal mock that returns configurable raw bytes for signing keys
contract StakingModule__MockBadKeys {
    bytes private _returned;

    function setReturned(bytes calldata data) external {
        _returned = data;
    }

    function getSigningKeys(
        uint256 /* nodeOpId */,
        uint256 /* startIndex */,
        uint256 /* keysCount */
    ) external view returns (bytes memory) {
        return _returned;
    }
}
