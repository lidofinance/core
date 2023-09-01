// SPDX-FileCopyrightText: 2023 OpenZeppelin, Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

/**
 * @dev Helper interface of EIP712 StETH-dedicated helper.
 *
 * Has an access to the CHAIN_ID opcode and relies on immutables internally
 * Both are unavailable for Solidity 0.4.24.
 */
interface IEIP712StETH {
    /**
     * @dev Returns the domain separator for the current chain.
     */
    function domainSeparatorV4(address _stETH) external view returns (bytes32);

    /**
     * @dev Given an already https://eips.ethereum.org/EIPS/eip-712#definition-of-hashstruct[hashed struct], this
     * function returns the hash of the fully encoded EIP712 message for this domain.
     *
     * This hash can be used together with {ECDSA-recover} to obtain the signer of a message. For example:
     *
     * ```solidity
     * bytes32 digest = hashTypedDataV4(keccak256(abi.encode(
     *     keccak256("Mail(address to,string contents)"),
     *     mailTo,
     *     keccak256(bytes(mailContents))
     * )));
     * address signer = ECDSA.recover(digest, signature);
     * ```
     */
    function hashTypedDataV4(address _stETH, bytes32 _structHash) external view returns (bytes32);

    /**
     * @dev returns the fields and values that describe the domain separator
     * used by stETH for EIP-712 signature.
     */
    function eip712Domain(address _stETH) external view returns (
        string memory name,
        string memory version,
        uint256 chainId,
        address verifyingContract
    );
}
