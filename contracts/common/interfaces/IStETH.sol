// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24;

/// @title StETH token interface
/// @notice Interface for the StETH token contract
interface IStETH {
    /// @notice Returns the amount of shares owned by an account
    /// @param _account The address to query
    /// @return The amount of shares owned by the account
    function sharesOf(address _account) external view returns (uint256);

    /// @notice Transfers shares from the caller to a recipient
    /// @param _recipient The address to transfer shares to
    /// @param _sharesAmount The amount of shares to transfer
    /// @return The amount of shares transferred
    function transferShares(address _recipient, uint256 _sharesAmount) external returns (uint256);

    /// @notice Approves a spender to spend tokens on behalf of the caller
    /// @param _spender The address to approve
    /// @param _amount The amount to approve
    /// @return True if the approval was successful
    function approve(address _spender, uint256 _amount) external returns (bool);

    /// TODO: try to import and/or document
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Resumed();
    event SharesBurnt(address indexed account, uint256 preRebaseTokenAmount, uint256 postRebaseTokenAmount, uint256 sharesAmount);
    event Stopped();
    event Transfer(address indexed from, address indexed to, uint256 value);
    event TransferShares(address indexed from, address indexed to, uint256 sharesValue);
    function allowance(address _owner, address _spender) external view returns (uint256);
    function balanceOf(address _account) external view returns (uint256);
    function decimals() external pure returns (uint8);
    function decreaseAllowance(address _spender, uint256 _subtractedValue) external returns (bool);
    function getPooledEthByShares(uint256 _sharesAmount) external view returns (uint256);
    function getSharesByPooledEth(uint256 _ethAmount) external view returns (uint256);
    function getTotalPooledEther() external view returns (uint256);
    function getTotalShares() external view returns (uint256);
    function increaseAllowance(address _spender, uint256 _addedValue) external returns (bool);
    function isStopped() external view returns (bool);
    function name() external pure returns (string memory);
    function symbol() external pure returns (string memory);
    function totalSupply() external view returns (uint256);
    function transfer(address _recipient, uint256 _amount) external returns (bool);
    function transferFrom(address _sender, address _recipient, uint256 _amount) external returns (bool);
    function transferSharesFrom(address _sender, address _recipient, uint256 _sharesAmount) external returns (uint256);
}