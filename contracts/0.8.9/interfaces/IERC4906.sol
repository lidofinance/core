// SPDX-FileCopyrightText: 2023 OpenZeppelin, Lido <info@lido.fi>
// SPDX-License-Identifier: MIT

// Based on https://github.com/OpenZeppelin/openzeppelin-contracts/blob/96a2297e15f1a4bbcf470d2d0d6cb9c579c63893/contracts/interfaces/IERC4906.sol

pragma solidity 0.8.9;

import {IERC165} from "@openzeppelin/contracts-v4.4/utils/introspection/IERC165.sol";
import {IERC721} from "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";

/// @title EIP-721 Metadata Update Extension
interface IERC4906 is IERC165, IERC721 {
    /// @dev This event emits when the metadata of a token is changed.
    /// So that the third-party platforms such as NFT market could
    /// timely update the images and related attributes of the NFT.
    event MetadataUpdate(uint256 _tokenId);

    /// @dev This event emits when the metadata of a range of tokens is changed.
    /// So that the third-party platforms such as NFT market could
    /// timely update the images and related attributes of the NFTs.
    event BatchMetadataUpdate(uint256 _fromTokenId, uint256 _toTokenId);
}
