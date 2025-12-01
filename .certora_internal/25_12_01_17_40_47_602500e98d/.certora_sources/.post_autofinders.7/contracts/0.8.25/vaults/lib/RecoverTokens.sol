
// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {SafeERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/utils/SafeERC20.sol";
import {IERC20} from "@openzeppelin/contracts-v5.2/token/ERC20/IERC20.sol";

library RecoverTokens {
    /**
     * @notice ETH address convention per EIP-7528
     */
    address internal constant ETH = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /**
     * @notice Emitted when the ERC20 `token` or ether is recovered (i.e. transferred)
     * @param to The address of the recovery recipient
     * @param assetAddress The address of the recovered ERC20 token (0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee for ether)
     * @param amount The amount of the token recovered
     */
    event AssetsRecovered(address indexed to, address indexed assetAddress, uint256 amount);

    /**
     * @notice Error thrown when recovery of ETH fails on transfer to recipient
     * @param recipient Address of the recovery recipient
     * @param amount Amount of ETH attempted to recover
     */
    error EthTransferFailed(address recipient, uint256 amount);

    function _recoverEth(
        address _recipient,
        uint256 _amount
    ) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff021f0000, 1037618709023) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff021f0001, 2) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff021f1000, _recipient) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff021f1001, _amount) }
        (bool success,) = payable(_recipient).call{value: _amount}("");assembly ("memory-safe"){mstore(0xffffff6e4604afefe123321beef1b02fffffffffffffffffffffffff00010013,0)}
        if (!success) revert EthTransferFailed(_recipient, _amount);

        emit AssetsRecovered(_recipient, ETH, _amount);
    }

    function _recoverERC20(
        address _token,
        address _recipient,
        uint256 _amount
    ) internal {assembly ("memory-safe") { mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02200000, 1037618709024) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02200001, 3) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02201000, _token) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02201001, _recipient) mstore(0xffffff6e4604afefe123321beef1b01fffffffffffffffffffffffff02201002, _amount) }
        SafeERC20.safeTransfer(IERC20(_token), _recipient, _amount);

        emit AssetsRecovered(_recipient, _token, _amount);
    }
}

