// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// Basic staking vault interface
interface Basic {
    function getWithdrawalCredentials() external view returns (bytes32);
    receive() external payable;
    function deposit(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) external;
    function withdraw(address _receiver, uint256 _etherToWithdraw) external;
}
