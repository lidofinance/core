// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import "openzeppelin-solidity/contracts/token/ERC721/ERC721.sol";

contract ERC721Mock is ERC721 {
    constructor() public ERC721() {}

    function mint(address _account, uint256 _tokenId) public {
        _mint(_account, _tokenId);
    }
}
