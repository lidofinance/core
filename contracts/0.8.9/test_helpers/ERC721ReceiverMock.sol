// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import { IERC721Receiver } from "@openzeppelin/contracts-v4.4/token/ERC721/IERC721Receiver.sol";

contract ERC721ReceiverMock is IERC721Receiver {
    bool public doesAcceptTokens;
    string public ERROR_MSG = "ERC721_NOT_ACCEPT_TOKENS";

    function setDoesAcceptTokens(bool _value) external {
        doesAcceptTokens = _value;
    }

    function onERC721Received(
        address, // operator,
        address, // from,
        uint256, // tokenId,
        bytes calldata // data
    ) external view returns (bytes4) {
        if (!doesAcceptTokens) {
            revert(ERROR_MSG);
        }
        return
            bytes4(
                keccak256("onERC721Received(address,address,uint256,bytes)")
            );
    }

    receive() external payable {
        if (!doesAcceptTokens) {
            revert(ERROR_MSG);
        }
    }
}
