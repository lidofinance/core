// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.0) (access/Ownable.sol)

pragma solidity ^0.8.20;

import {ContextUpgradeable} from "../utils/ContextUpgradeable.sol";
import {Initializable} from "../proxy/utils/Initializable.sol";

/**
 * @dev Contract module which provides a basic access control mechanism, where
 * there is an account (an owner) that can be granted exclusive access to
 * specific functions.
 *
 * The initial owner is set to the address provided by the deployer. This can
 * later be changed with {transferOwnership}.
 *
 * This module is used through inheritance. It will make available the modifier
 * `onlyOwner`, which can be applied to your functions to restrict their use to
 * the owner.
 */
abstract contract OwnableUpgradeable is Initializable, ContextUpgradeable {
    /// @custom:storage-location erc7201:openzeppelin.storage.Ownable
    struct OwnableStorage {
        address _owner;
    }

    // keccak256(abi.encode(uint256(keccak256("openzeppelin.storage.Ownable")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant OwnableStorageLocation =
        0x9016d09d72d40fdae2fd8ceac6b6234c7706214fd39c1cd1e609a0528c199300;

    function _getOwnableStorage() private pure returns (OwnableStorage storage $) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02300000, 1037618709040) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02300001, 0) }
        assembly {
            $.slot := OwnableStorageLocation
        }
    }

    /**
     * @dev The caller account is not authorized to perform an operation.
     */
    error OwnableUnauthorizedAccount(address account);

    /**
     * @dev The owner is not a valid owner account. (eg. `address(0)`)
     */
    error OwnableInvalidOwner(address owner);

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    /**
     * @dev Initializes the contract setting the address provided by the deployer as the initial owner.
     */
    function __Ownable_init(address initialOwner) internal logInternal561(initialOwner)onlyInitializing {
        __Ownable_init_unchained(initialOwner);
    }modifier logInternal561(address initialOwner) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02310000, 1037618709041) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02310001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02311000, initialOwner) } _; }

    function __Ownable_init_unchained(address initialOwner) internal logInternal563(initialOwner)onlyInitializing {
        if (initialOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(initialOwner);
    }modifier logInternal563(address initialOwner) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02330000, 1037618709043) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02330001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02331000, initialOwner) } _; }

    /**
     * @dev Throws if called by any account other than the owner.
     */
    modifier onlyOwner() {
        _checkOwner();
        _;
    }

    /**
     * @dev Returns the address of the current owner.
     */
    function owner() public view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022f0000, 1037618709039) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff022f0001, 0) }
        OwnableStorage storage $ = _getOwnableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010021,0)}
        return $._owner;
    }

    /**
     * @dev Throws if the sender is not the owner.
     */
    function _checkOwner() internal view virtual {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02340000, 1037618709044) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02340001, 0) }
        if (owner() != _msgSender()) {
            revert OwnableUnauthorizedAccount(_msgSender());
        }
    }

    /**
     * @dev Leaves the contract without owner. It will not be possible to call
     * `onlyOwner` functions. Can only be called by the current owner.
     *
     * NOTE: Renouncing ownership will leave the contract without an owner,
     * thereby disabling any functionality that is only available to the owner.
     */
    function renounceOwnership() public virtual logInternal566()onlyOwner {
        _transferOwnership(address(0));
    }modifier logInternal566() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02360000, 1037618709046) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02360001, 0) } _; }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Can only be called by the current owner.
     */
    function transferOwnership(address newOwner) public virtual logInternal565(newOwner)onlyOwner {
        if (newOwner == address(0)) {
            revert OwnableInvalidOwner(address(0));
        }
        _transferOwnership(newOwner);
    }modifier logInternal565(address newOwner) { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02350000, 1037618709045) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02350001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02351000, newOwner) } _; }

    /**
     * @dev Transfers ownership of the contract to a new account (`newOwner`).
     * Internal function without access restriction.
     */
    function _transferOwnership(address newOwner) internal virtual {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02320000, 1037618709042) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02320001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02321000, newOwner) }
        OwnableStorage storage $ = _getOwnableStorage();assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010022,0)}
        address oldOwner = $._owner;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000023,oldOwner)}
        $._owner = newOwner;address certora_local36 = $._owner;assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00000024,certora_local36)}
        emit OwnershipTransferred(oldOwner, newOwner);
    }
}
