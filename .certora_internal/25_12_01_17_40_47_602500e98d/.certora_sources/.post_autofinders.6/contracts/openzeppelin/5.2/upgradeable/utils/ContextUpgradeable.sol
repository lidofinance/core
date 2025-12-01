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
    function __Context_init() internal logInternal421()onlyInitializing {
    }modifier logInternal421() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a50000, 1037618708901) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a50001, 0) } _; }

    function __Context_init_unchained() internal logInternal422()onlyInitializing {
    }modifier logInternal422() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a60000, 1037618708902) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a60001, 0) } _; }
    function _msgSender() internal view virtual returns (address) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a80000, 1037618708904) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a80001, 0) }
        return msg.sender;
    }

    function _msgData() internal view virtual returns (bytes calldata) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a90000, 1037618708905) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a90001, 0) }
        return msg.data;
    }

    function _contextSuffixLength() internal view virtual returns (uint256) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a70000, 1037618708903) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff01a70001, 0) }
        return 0;
    }
}
