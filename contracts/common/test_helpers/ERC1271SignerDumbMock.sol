// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;


contract ERC1271SignerDumbMock {
    error InvalidSignature();

    struct Config {
        bytes4 retval;
        bool reverts;
    }

    Config internal _config;

    function configure(Config memory config) external {
        _config = config;
    }

    function isValidSignature(bytes32 /* hash */, bytes memory /* sig */) external view returns (bytes4) {
        if (_config.reverts) revert InvalidSignature();
        return _config.retval;
    }
}
