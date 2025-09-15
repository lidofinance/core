
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts-v5.2/token/ERC721/IERC721.sol";


library RecoverTokens {
    /**
     * @notice ETH address convention per EIP-7528
     */
    address public constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /**
     * @notice Emitted when the ERC20 `token` or ether is recovered (i.e. transferred)
     * @param to The address of the recovery recipient
     * @param token The address of the recovered ERC20 token (0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee for ether)
     * @param amount The amount of the token recovered
     */
    event ERC20Recovered(address indexed to, address indexed token, uint256 amount);

    /**
     * @notice Emitted when the ERC721-compatible `token` (NFT) recovered (i.e. transferred)
     * @param to The address of the recovery recipient
     * @param token The address of the recovered ERC721 token
     * @param tokenId id of token recovered
     */
    event ERC721Recovered(address indexed to, address indexed token, uint256 tokenId);


    /**
     * @notice Error thrown when recovery of ETH fails on transfer to recipient
     * @param recipient Address of the recovery recipient
     * @param amount Amount of ETH attempted to recover
     */
    error EthTransferFailed(address recipient, uint256 amount);

    function _recoverEth(
        address _recipient,
        uint256 _amount
    ) internal {
        (bool success,) = payable(_recipient).call{value: _amount}("");
        if (!success) revert EthTransferFailed(_recipient, _amount);

        emit ERC20Recovered(_recipient, ETH, _amount);
    }

    function _recoverERC20(
        address _token,
        address _recipient,
        uint256 _amount
    ) internal {
        SafeERC20.safeTransfer(IERC20(_token), _recipient, _amount);
        
        emit ERC20Recovered(_recipient, _token, _amount);
    }

    /**
     * @notice Transfers a given token_id of an ERC721-compatible NFT (defined by the token contract address)
     * from the dashboard contract to sender
     *
     * @param _token an ERC721-compatible token
     * @param _recipient Address of the recovery recipient
     * @param _tokenId token id to recover
     */
    function _recoverERC721(
        address _token,
        address _recipient,
        uint256 _tokenId
    ) internal {
        IERC721(_token).safeTransferFrom(address(this), _recipient, _tokenId);

        emit ERC721Recovered(_recipient, _token, _tokenId);
    }

}

