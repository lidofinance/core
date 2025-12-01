// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.0.1) (utils/Context.sol)

pragma solidity ^0.8.20;
import {Initializable} from "../proxy/utils/Initializable.sol";

/**
 * @dev Provides information about the current execution context, including the
 * sender of the transaction and its data. While these are generally available
 * via msg.sender and msg.data, they should not be accessed in such a direct
 * manner, since when dealing with meta-transactions the account sending and
 * paying for execution may not be the actual sender (as far as an application
 * is concerned).
 *
 * This contract is only required for intermediate, library-like contracts.
 */
abstract contract ContextUpgradeable is Initializable {
    function __Context_init() internal logInternal702()onlyInitializing {
    }modifier logInternal702() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02be0000, 1037618709182) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02be0001, 0) } _; }

    function __Context_init_unchained() internal logInternal703()onlyInitializing {
    }modifier logInternal703() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02bf0000, 1037618709183) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02bf0001, 0) } _; }
    function _msgSender() internal view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c10000, 1037618709185) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c10001, 0) }
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c20000, 1037618709186) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c20001, 0) }
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c00000, 1037618709184) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c00001, 0) }
        return 0;
    }
}
