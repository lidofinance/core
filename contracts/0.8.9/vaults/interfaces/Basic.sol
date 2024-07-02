// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

/// Basic staking vault interface
interface Basic {
    function getWithdrawalCredentials() external view returns (bytes32);
    function deposit() external payable;
    /// @notice vault can aquire EL rewards by direct transfer
    receive() external payable;
    function withdraw(address receiver, uint256 etherToWithdraw) external;

    function depositKeys(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) external;
}
