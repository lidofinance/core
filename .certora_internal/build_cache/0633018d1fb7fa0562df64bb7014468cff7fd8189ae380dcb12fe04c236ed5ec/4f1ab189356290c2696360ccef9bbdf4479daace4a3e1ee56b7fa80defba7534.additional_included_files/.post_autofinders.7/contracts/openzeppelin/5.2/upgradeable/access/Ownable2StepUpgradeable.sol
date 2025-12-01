// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (access/Ownable2Step.sol)

pragma solidity ^0.8.20;

import {OwnableUpgradeable} from "./OwnableUpgradeable.sol";
import {Initializable} from "../proxy/utils/Initializable.sol";

/**
 * @dev Contract module which provides access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * This extension of the {Ownable} contract includes a two-step mechanism to transfer
 * ownership, where the new owner must call {acceptOwnership} in order to replace the
 * old one. This can help prevent common mistakes, such as transfers of ownership to
 * incorrect accounts, or to contracts that are unable to interact with the
 * permission system.
 *
 * The initial owner is specified at deployment time in the constructor for `Ownable`. This
 * can later be changed with {transferOwnership} and {acceptOwnership}.
 *
 * This module is used through inheritance. It will make available all functions
 * from parent (Ownable).
 */
abstract contract Ownable2StepUpgradeable is Initializable, OwnableUpgradeable {
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable2Step
    struct Ownable2StepStorage {
        address _pendingOwner;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Ownable2Step")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant Ownable2StepStorageLocation = 0x237e158222e3e6968b72b9db0d8043aacf074ad9f650f0d1606b4d82ee432c00;

    function _getOwnable2StepStorage() private pure returns (Ownable2StepStorage storage $) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02270000, 1037618709031) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02270001, 0) }
        assembly {
            $.slot := Ownable2StepStorageLocation
        }
    }

    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);

    function __Ownable2Step_init() internal logInternal552()onlyInitializing {
    }modifier logInternal552() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02280000, 1037618709032) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02280001, 0) } _; }

    function __Ownable2Step_init_unchained() internal logInternal553()onlyInitializing {
    }modifier logInternal553() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02290000, 1037618709033) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02290001, 0) } _; }
    /**
     * @dev Returns the address of the pending owner.
     */
    function pendingOwner() public view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022e0000, 1037618709038) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022e0001, 0) }
        Ownable2StepStorage storage $ = _getOwnable2StepStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001c,0)}
        return $._pendingOwner;
    }

    /**
     * @dev Starts the ownership transfer of the contract to a new account. Replaces the pending transfer if there is one.
     * Can only be called by the current owner.
     *
     * Setting `newOwner` to the zero address is allowed; this can be used to cancel an initiated ownership transfer.
     */
    function transferOwnership(address newOwner) public virtual override logInternal556(newOwner)onlyOwner {
        Ownable2StepStorage storage $ = _getOwnable2StepStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001d,0)}
        $._pendingOwner = newOwner;address certora_local32 = $._pendingOwner;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000020,certora_local32)}
        emit OwnershipTransferStarted(owner(), newOwner);
    }modifier logInternal556(address newOwner) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022c0000, 1037618709036) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022c0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022c1000, newOwner) } _; }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`) and deletes any pending owner.
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual override {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022a0000, 1037618709034) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022a0001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022a1000, newOwner) }
        Ownable2StepStorage storage $ = _getOwnable2StepStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0001001e,0)}
        delete $._pendingOwner;
        super._transferOwnership(newOwner);
    }

    /**
     * @dev The new owner accepts the ownership transfer.
     */
    function acceptOwnership() public virtual {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022d0000, 1037618709037) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022d0001, 0) }
        address sender = _msgSender();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff0000001f,sender)}
        if (pendingOwner() != sender) {
            revert OwnableUnauthorizedAccount(sender);
        }
        _transferOwnership(sender);
    }
}