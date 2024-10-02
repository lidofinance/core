// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {StakingVault} from "./StakingVault.sol";
import {ILiquid} from "./interfaces/ILiquid.sol";
import {ILockable} from "./interfaces/ILockable.sol";
import {ILiquidity} from "./interfaces/ILiquidity.sol";

// TODO: add erc-4626-like can* methods
// TODO: escape hatch (permissionless update and burn and withdraw)
// TODO: add sanity checks
// TODO: unstructured storage
// TODO: add AUM fee

contract LiquidStakingVault is StakingVault, ILiquid, ILockable {
    uint256 private constant MAX_FEE = 10000;
    ILiquidity public immutable LIQUIDITY_PROVIDER;

    struct Report {
        uint128 value;
        int128 netCashFlow;
    }

    Report public lastReport;
    Report public lastClaimedReport;

    uint256 public locked;

    // Is direct validator depositing affects this accounting?
    int256 public netCashFlow;

    uint256 nodeOperatorFee;

    constructor(
        address _liquidityProvider,
        address _owner,
        address _depositContract
    ) StakingVault(_owner, _depositContract) {
        LIQUIDITY_PROVIDER = ILiquidity(_liquidityProvider);
    }

    function value() public view override returns (uint256) {
        return uint256(int128(lastReport.value) + netCashFlow - lastReport.netCashFlow);
    }

    function isHealthy() public view returns (bool) {
        return locked <= value();
    }

    function deposit() public payable override(StakingVault) {
        netCashFlow += int256(msg.value);

        super.deposit();
    }

    function withdraw(address _receiver, uint256 _amount) public override(StakingVault) {
        if (_receiver == address(0)) revert ZeroArgument("receiver");
        if (_amount == 0) revert ZeroArgument("amount");
        if (_amount + locked > value()) revert NotHealthy(locked, value() - _amount);

        netCashFlow -= int256(_amount);

        super.withdraw(_receiver, _amount);

        _mustBeHealthy();
    }

    function topupValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public override(StakingVault) {
        // unhealthy vaults are up to force rebalancing
        // so, we don't want it to send eth back to the Beacon Chain
        _mustBeHealthy();

        super.topupValidators(_keysCount, _publicKeysBatch, _signaturesBatch);
    }

    function mint(
        address _receiver,
        uint256 _amountOfTokens
    ) external payable onlyRole(VAULT_MANAGER_ROLE) andDeposit() {
        if (_receiver == address(0)) revert ZeroArgument("receiver");
        if (_amountOfTokens == 0) revert ZeroArgument("amountOfShares");

        uint256 newLocked = LIQUIDITY_PROVIDER.mintStethBackedByVault(_receiver, _amountOfTokens);

        if (newLocked > locked) {
            locked = newLocked;

            emit Locked(newLocked);
        }
    }

    function burn(uint256 _amountOfTokens) external onlyRole(VAULT_MANAGER_ROLE) {
        if (_amountOfTokens == 0) revert ZeroArgument("amountOfShares");

        // burn shares at once but unlock balance later during the report
        LIQUIDITY_PROVIDER.burnStethBackedByVault(_amountOfTokens);
    }

    function rebalance(uint256 _amountOfETH) external payable andDeposit(){
        if (_amountOfETH == 0) revert ZeroArgument("amountOfETH");
        if (address(this).balance < _amountOfETH) revert NotEnoughBalance(address(this).balance);

        if (hasRole(VAULT_MANAGER_ROLE, msg.sender) ||
           (!isHealthy() && msg.sender == address(LIQUIDITY_PROVIDER))) { // force rebalance
            // TODO: check rounding here
            // mint some stETH in Lido v2 and burn it on the vault
            netCashFlow -= int256(_amountOfETH);
            emit Withdrawal(msg.sender, _amountOfETH);

            LIQUIDITY_PROVIDER.rebalance{value: _amountOfETH}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    function update(uint256 _value, int256 _ncf, uint256 _locked) external {
        if (msg.sender != address(LIQUIDITY_PROVIDER)) revert NotAuthorized("update", msg.sender);

        lastReport = Report(uint128(_value), int128(_ncf)); //TODO: safecast
        locked = _locked;

        emit Reported(_value, _ncf, _locked);
    }

    function setNodeOperatorFee(uint256 _nodeOperatorFee) external onlyRole(VAULT_MANAGER_ROLE) {
        nodeOperatorFee = _nodeOperatorFee;
    }

    function claimNodeOperatorFee(address _receiver) external {
        if (!hasRole(NODE_OPERATOR_ROLE, msg.sender)) revert NotAuthorized("claimNodeOperatorFee", msg.sender);

        int128 earnedRewards = int128(lastReport.value - lastClaimedReport.value)
                - (lastReport.netCashFlow - lastClaimedReport.netCashFlow);

        if (earnedRewards > 0) {
            lastClaimedReport = lastReport;

            uint256 nodeOperatorFeeAmount = uint128(earnedRewards) * nodeOperatorFee / MAX_FEE;
            uint256 newLocked = LIQUIDITY_PROVIDER.mintStethBackedByVault(_receiver, nodeOperatorFeeAmount);

            if (newLocked > locked) {
                locked = newLocked;

                emit Locked(newLocked);
            }
        }
    }

    function _mustBeHealthy() private view {
        if (locked > value()) revert NotHealthy(locked, value());
    }

    modifier andDeposit() {
        if (msg.value > 0) {
            deposit();
        }
        _;
    }

    error NotHealthy(uint256 locked, uint256 value);
}
