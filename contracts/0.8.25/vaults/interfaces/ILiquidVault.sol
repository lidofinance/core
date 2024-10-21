// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {IVault} from "./IVault.sol";

interface IHub {
    function mintStethBackedByVault(
        address _receiver,
        uint256 _amountOfTokens
    ) external returns (uint256 totalEtherToLock);

    function burnStethBackedByVault(uint256 _amountOfTokens) external;

    function rebalance() external payable;

    event MintedStETHOnVault(address indexed vault, uint256 amountOfTokens);
    event BurnedStETHOnVault(address indexed vault, uint256 amountOfTokens);
    event VaultRebalanced(address indexed vault, uint256 tokensBurnt, uint256 newBondRateBP);
}

interface ILiquidVault {
    error NotHealthy(uint256 locked, uint256 value);
    error InsufficientUnlocked(uint256 unlocked, uint256 requested);
    error NeedToClaimAccumulatedNodeOperatorFee();
    error NotAuthorized(string operation, address sender);

    event Reported(uint256 valuation, int256 inOutDelta, uint256 locked);
    event Rebalanced(uint256 amount);
    event Locked(uint256 amount);
    event ReportSubscriptionFailed(address subscriber, bytes4 callback);

    struct Report {
        uint128 valuation;
        int128 inOutDelta;
    }

    struct ReportSubscription {
        address subscriber;
        bytes4 callback;
    }

    function getHub() external view returns (IHub);

    function getLatestReport() external view returns (Report memory);

    function getLocked() external view returns (uint256);

    function getInOutDelta() external view returns (int256);

    function valuation() external view returns (uint256);

    function isHealthy() external view returns (bool);

    function getWithdrawableAmount() external view returns (uint256);

    function mint(address _recipient, uint256 _amount) external payable;

    function burn(uint256 _amount) external;

    function rebalance(uint256 _amount) external payable;

    function update(uint256 _value, int256 _inOutDelta, uint256 _locked) external;
}
