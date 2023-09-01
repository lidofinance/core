// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;


contract ERC1271SignerMock {
    struct Config {
        bytes32 validHash;
        bytes validSig;
        bytes4 retvalOnValid;
        bytes4 retvalOnInvalid;
    }

    Config internal _config;

    function configure(Config memory config) external {
        _config = config;
    }

    function isValidSignature(bytes32 hash, bytes memory sig) external view returns (bytes4) {
        Config memory cfg = _config;

        return hash == cfg.validHash && keccak256(sig) == keccak256(cfg.validSig)
            ? cfg.retvalOnValid
            : cfg.retvalOnInvalid;
    }

}
