// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;


contract ERC1271MutatingSignerMock {
    uint256 public callCount_isValidSignature;

    function isValidSignature(bytes32 /* hash */, bytes memory /* sig */) external returns (bytes4) {
        ++callCount_isValidSignature;
        return 0x1626ba7e;
    }
}
