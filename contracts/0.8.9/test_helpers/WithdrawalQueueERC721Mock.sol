// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.9;

import {WithdrawalQueueERC721} from "../WithdrawalQueueERC721.sol";

contract WithdrawalQueueERC721Mock is WithdrawalQueueERC721 {
    constructor(
        address _wstETH,
        string memory _name,
        string memory _symbol
    ) WithdrawalQueueERC721(_wstETH, _name, _symbol) {
    }

    function getQueueItem(uint256 id) external view returns (WithdrawalRequest memory) {
        return _getQueue()[id];
    }

    function getCheckpointItem(uint256 id) external view returns (Checkpoint memory) {
        return _getCheckpoints()[id];
    }
}
