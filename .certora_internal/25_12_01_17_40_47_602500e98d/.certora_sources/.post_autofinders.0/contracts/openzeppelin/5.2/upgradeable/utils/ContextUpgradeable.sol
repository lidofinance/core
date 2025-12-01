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
    function __Context_init() internal logInternal153()onlyInitializing {
    }modifier logInternal153() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00990000, 1037618708633) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff00990001, 0) } _; }

    function __Context_init_unchained() internal logInternal154()onlyInitializing {
    }modifier logInternal154() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009a0000, 1037618708634) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009a0001, 0) } _; }
    function _msgSender() internal view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009c0000, 1037618708636) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009c0001, 0) }
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009d0000, 1037618708637) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009d0001, 0) }
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009b0000, 1037618708635) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff009b0001, 0) }
        return 0;
    }
}
