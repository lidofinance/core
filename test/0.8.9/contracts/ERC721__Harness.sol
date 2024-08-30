// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {ERC721} from "@openzeppelin/contracts-v4.4/token/ERC721/ERC721.sol";

contract ERC721__Harness is ERC721 {
    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    function mint(address to, uint256 id) external {
        super._mint(to, id);
    }
}
