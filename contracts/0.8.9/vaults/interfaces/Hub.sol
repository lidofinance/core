// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {Connected} from "./Connected.sol";

interface Hub {
    function addVault(Connected _vault, uint256 _capShares) external;
    function mintSharesBackedByVault(address _receiver, uint256 _amountOfShares) external returns (uint256);
    function burnSharesBackedByVault(address _account, uint256 _amountOfShares) external;
    function forgive() external payable;
}
