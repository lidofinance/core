// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.5.0;

import {IERC20}  from "@openzeppelin/contracts-v4.4/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v4.4/token/ERC721/IERC721.sol";

interface IWithdrawalVault {
    function initialize() external;
    function finalizeUpgrade_v2() external;
    function withdrawWithdrawals(uint256 _amount) external;
    function recoverERC20(IERC20 _token, uint256 _amount) external;
    function recoverERC721(IERC721 _token, uint256 _tokenId) external;
    function addWithdrawalRequests(bytes[] calldata pubkeys, uint64[] calldata amounts) external payable;
    function getWithdrawalRequestFee() external view returns (uint256);
}
