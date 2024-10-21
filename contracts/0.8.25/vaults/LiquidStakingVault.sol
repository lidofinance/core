// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Vault} from "./Vault.sol";
import {ILiquid} from "./interfaces/ILiquid.sol";
import {ILockable} from "./interfaces/ILockable.sol";
import {ILiquidity} from "./interfaces/ILiquidity.sol";

// TODO: add erc-4626-like can* methods
// TODO: add sanity checks
// TODO: unstructured storage
contract LiquidStakingVault is Vault, ILiquid, ILockable {
    uint256 private constant MAX_FEE = 10000;
    ILiquidity public immutable LIQUIDITY_PROVIDER;

    struct Report {
        uint128 value;
        int128 netCashFlow;
    }

    Report public lastReport;

    uint256 public locked;

    // Is direct validator depositing affects this accounting?
    int256 public netCashFlow;

    uint256 vaultOwnerFee;

    uint256 public accumulatedVaultOwnerFee;

    constructor(address _liquidityProvider, address _owner, address _depositContract) Vault(_owner, _depositContract) {
        LIQUIDITY_PROVIDER = ILiquidity(_liquidityProvider);
    }

    function value() public view override returns (uint256) {
        return uint256(int128(lastReport.value) + netCashFlow - lastReport.netCashFlow);
    }

    function isHealthy() public view returns (bool) {
        return locked <= value();
    }

    function canWithdraw() public view returns (uint256) {
        if (locked > value()) return 0;

        return value() - locked;
    }

    function fund() public payable override(Vault) {
        netCashFlow += int256(msg.value);

        super.fund();
    }

    function withdraw(address _receiver, uint256 _amount) public override(Vault) {
        if (_receiver == address(0)) revert Zero("receiver");
        if (_amount == 0) revert Zero("amount");
        if (canWithdraw() < _amount) revert NotEnoughUnlockedEth(canWithdraw(), _amount);

        _withdraw(_receiver, _amount);

        _mustBeHealthy();
    }

    function deposit(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public override(Vault) {
        // unhealthy vaults are up to force rebalancing
        // so, we don't want it to send eth back to the Beacon Chain
        _mustBeHealthy();

        super.deposit(_keysCount, _publicKeysBatch, _signaturesBatch);
    }

    function mint(address _receiver, uint256 _amountOfTokens) external payable onlyOwner andFund {
        if (_receiver == address(0)) revert Zero("receiver");
        if (_amountOfTokens == 0) revert Zero("amountOfShares");

        _mint(_receiver, _amountOfTokens);
    }

    function burn(uint256 _amountOfTokens) external onlyOwner {
        if (_amountOfTokens == 0) revert Zero("amountOfShares");

        // burn shares at once but unlock balance later during the report
        LIQUIDITY_PROVIDER.burnStethBackedByVault(_amountOfTokens);
    }

    function rebalance(uint256 _amountOfETH) external payable andFund {
        if (_amountOfETH == 0) revert Zero("amountOfETH");
        if (address(this).balance < _amountOfETH) revert InsufficientBalance(address(this).balance);

        if (owner() == msg.sender || (!isHealthy() && msg.sender == address(LIQUIDITY_PROVIDER))) {
            // force rebalance
            // TODO: check rounding here
            // mint some stETH in Lido v2 and burn it on the vault
            netCashFlow -= int256(_amountOfETH);
            emit Withdrawn(msg.sender, msg.sender, _amountOfETH);

            LIQUIDITY_PROVIDER.rebalance{value: _amountOfETH}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    function update(uint256 _value, int256 _ncf, uint256 _locked) external {
        if (msg.sender != address(LIQUIDITY_PROVIDER)) revert NotAuthorized("update", msg.sender);

        lastReport = Report(uint128(_value), int128(_ncf)); //TODO: safecast
        locked = _locked;

        accumulatedVaultOwnerFee += (_value * vaultOwnerFee) / 365 / MAX_FEE;

        emit Reported(_value, _ncf, _locked);
    }

    function _withdraw(address _receiver, uint256 _amountOfTokens) internal {
        netCashFlow -= int256(_amountOfTokens);
        super.withdraw(_receiver, _amountOfTokens);
    }

    function _mint(address _receiver, uint256 _amountOfTokens) internal {
        uint256 newLocked = LIQUIDITY_PROVIDER.mintStethBackedByVault(_receiver, _amountOfTokens);

        if (newLocked > locked) {
            locked = newLocked;

            emit Locked(newLocked);
        }
    }

    function _mustBeHealthy() private view {
        if (locked > value()) revert NotHealthy(locked, value());
    }

    modifier andFund() {
        if (msg.value > 0) {
            fund();
        }
        _;
    }

    function _max(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a : b;
    }

    error NotHealthy(uint256 locked, uint256 value);
    error NotEnoughUnlockedEth(uint256 unlocked, uint256 amount);
    error NeedToClaimAccumulatedNodeOperatorFee();
    error NotAuthorized(string operation, address sender);
}
