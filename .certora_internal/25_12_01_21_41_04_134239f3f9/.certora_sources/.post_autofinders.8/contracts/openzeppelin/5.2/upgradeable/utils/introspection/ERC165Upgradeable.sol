// SPDX-License-Identifier: MIT
// OpenZeppelin Contracts (last updated v5.1.0) (utils/introspection/ERC165.sol)

pragma solidity ^0.8.20;

import {IERC165} from "@openzeppelin/contracts-v5.2/utils/introspection/IERC165.sol";
import {Initializable} from "../../proxy/utils/Initializable.sol";

/**
 * @dev Implementation of the {IERC165} interface.
 *
 * Contracts that want to implement ERC-165 should inherit from this contract and override {supportsInterface} to check
 * for the additional interface id that will be supported. For example:
 *
 * ```solidity
 * function supportsInterface(bytes4 interfaceId) public view virtual override returns (bool) {
 *     return interfaceId == type(MyInterface).interfaceId || super.supportsInterface(interfaceId);
 * }
 * ```
 */
abstract contract ERC165Upgradeable is Initializable, IERC165 {
    function __ERC165_init() internal logInternal707()onlyInitializing {
    }modifier logInternal707() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c30000, 1037618709187) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c30001, 0) } _; }

    function __ERC165_init_unchained() internal logInternal708()onlyInitializing {
    }modifier logInternal708() { assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c40000, 1037618709188) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c40001, 0) } _; }
    /**
     * @dev See {IERC165-supportsInterface}.
     */
    function supportsInterface(bytes4 interfaceId) public view virtual returns (bool) {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c50000, 1037618709189) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c50001, 1) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02c51000, interfaceId) }
        return interfaceId == type(IERC165).interfaceId;
    }
}
