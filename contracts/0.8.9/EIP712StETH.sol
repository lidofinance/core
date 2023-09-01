// SPDX-FileCopyrightText: 2023 OpenZeppelin, Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {ECDSA} from "@openzeppelin/contracts-v4.4/utils/cryptography/ECDSA.sol";

import {IEIP712StETH} from "../common/interfaces/IEIP712StETH.sol";

/**
 * NOTE: The code below is taken from "@openzeppelin/contracts-v4.4/utils/cryptography/draft-EIP712.sol"
 * With a main difference to store the stETH contract address internally and use it for signing.
 */

/**
 * @dev https://eips.ethereum.org/EIPS/eip-712[EIP 712] is a standard for hashing and signing of typed structured data.
 *
 * The encoding specified in the EIP is very generic, and such a generic implementation in Solidity is not feasible,
 * thus this contract does not implement the encoding itself. Protocols need to implement the type-specific encoding
 * they need in their contracts using a combination of `abi.encode` and `keccak256`.
 *
 * This contract implements the EIP 712 domain separator ({_domainSeparatorV4}) that is used as part of the encoding
 * scheme, and the final step of the encoding to obtain the message digest that is then signed via ECDSA
 * ({_hashTypedDataV4}).
 *
 * The implementation of the domain separator was designed to be as efficient as possible while still properly updating
 * the chain id to protect against replay attacks on an eventual fork of the chain.
 *
 * NOTE: This contract implements the version of the encoding known as "v4", as implemented by the JSON RPC method
 * https://docs.metamask.io/guide/signing-data.html[`eth_signTypedDataV4` in MetaMask].
 *
 */
contract EIP712StETH is IEIP712StETH {
    /* solhint-disable var-name-mixedcase */
    // Cache the domain separator as an immutable value, but also store the chain id that it corresponds to, in order to
    // invalidate the cached domain separator if the chain id changes.
    bytes32 private immutable _CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable _CACHED_CHAIN_ID;
    address private immutable _CACHED_STETH;

    bytes32 private immutable _HASHED_NAME;
    bytes32 private immutable _HASHED_VERSION;
    bytes32 private immutable _TYPE_HASH;

    error ZeroStETHAddress();

    /**
     * @dev Constructs specialized EIP712 instance for StETH token, version "2".
     */
    constructor(address _stETH) {
        if (_stETH == address(0)) { revert ZeroStETHAddress(); }

        bytes32 hashedName = keccak256("Liquid staked Ether 2.0");
        bytes32 hashedVersion = keccak256("2");
        bytes32 typeHash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
        );

        _HASHED_NAME = hashedName;
        _HASHED_VERSION = hashedVersion;
        _CACHED_CHAIN_ID = block.chainid;
        _CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator(typeHash, hashedName, hashedVersion, _stETH);
        _CACHED_STETH = _stETH;
        _TYPE_HASH = typeHash;
    }

    /**
     * @dev Returns the domain separator for the current chain.
     */
    function domainSeparatorV4(address _stETH) public view override returns (bytes32) {
        if (_stETH == _CACHED_STETH && block.chainid == _CACHED_CHAIN_ID) {
            return _CACHED_DOMAIN_SEPARATOR;
        } else {
            return _buildDomainSeparator(_TYPE_HASH, _HASHED_NAME, _HASHED_VERSION, _stETH);
        }
    }

    function _buildDomainSeparator(
        bytes32 _typeHash,
        bytes32 _nameHash,
        bytes32 _versionHash,
        address _stETH
    ) private view returns (bytes32) {
        return keccak256(abi.encode(_typeHash, _nameHash, _versionHash, block.chainid, _stETH));
    }

    /**
     * @dev Given an already https://eips.ethereum.org/EIPS/eip-712#definition-of-hashstruct[hashed struct], this
     * function returns the hash of the fully encoded EIP712 message for this domain.
     *
     * This hash can be used together with {ECDSA-recover} to obtain the signer of a message. For example:
     *
     * ```solidity
     * bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(
     *     keccak256("Mail(address to,string contents)"),
     *     mailTo,
     *     keccak256(bytes(mailContents))
     * )));
     * address signer = ECDSA.recover(digest, signature);
     * ```
     */
    function hashTypedDataV4(address _stETH, bytes32 _structHash) external view override returns (bytes32) {
        return ECDSA.toTypedDataHash(domainSeparatorV4(_stETH), _structHash);
    }

    /**
     * @dev returns the fields and values that describe the domain separator
     * used by stETH for EIP-712 signature.
     */
    function eip712Domain(address _stETH) external view returns (
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    ) {
        return (
            "Liquid staked Ether 2.0",
            "2",
            block.chainid,
            _stETH
        );
    }
}
