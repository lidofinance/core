// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

/**
 * @dev Mock for source staking module (CMv1/NOR) for ConsolidationMigrator tests
 */
contract SourceModule__MockForConsolidationMigrator {
    struct SigningKey {
        bytes pubkey;
        bytes depositSignature;
        bool used;
    }

    // operatorId => keyIndex => SigningKey
    mapping(uint256 => mapping(uint256 => SigningKey)) internal _signingKeys;

    function mock__setSigningKey(uint256 operatorId, uint256 keyIndex, bytes calldata pubkey, bool used) external {
        _signingKeys[operatorId][keyIndex] = SigningKey({pubkey: pubkey, depositSignature: new bytes(96), used: used});
    }

    function getSigningKey(
        uint256 _nodeOperatorId,
        uint256 _index
    ) external view returns (bytes memory key, bytes memory depositSignature, bool used) {
        SigningKey storage sk = _signingKeys[_nodeOperatorId][_index];
        return (sk.pubkey, sk.depositSignature, sk.used);
    }
}
