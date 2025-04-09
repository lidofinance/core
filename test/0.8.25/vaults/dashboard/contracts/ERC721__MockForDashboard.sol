// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {ERC721} from "@openzeppelin/contracts-v5.2/token/ERC721/ERC721.sol";

contract ERC721__MockForDashboard is ERC721 {
    constructor() ERC721("MockERC721", "M721") {}

    function mint(address _recipient, uint256 _tokenId) external {
        _mint(_recipient, _tokenId);
    }
}
