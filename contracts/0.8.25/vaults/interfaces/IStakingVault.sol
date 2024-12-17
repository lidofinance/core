// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

interface IStakingVault {
    struct Report {
        uint128 valuation;
        int128 inOutDelta;
    }

    function initialize(address factory, address owner, address operator, bytes calldata params) external;

    function vaultHub() external view returns (address);

    function factory() external view returns (address);

    function operator() external view returns (address);

    function latestReport() external view returns (Report memory);

    function locked() external view returns (uint256);

    function inOutDelta() external view returns (int256);

    function valuation() external view returns (uint256);

    function isBalanced() external view returns (bool);

    function unlocked() external view returns (uint256);

    function withdrawalCredentials() external view returns (bytes32);

    function fund() external payable;

    function withdraw(address _recipient, uint256 _ether) external;

    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external;

    function requestValidatorExit(bytes calldata _validatorPublicKey) external;

    function lock(uint256 _locked) external;

    function rebalance(uint256 _ether) external;

    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external;
}
