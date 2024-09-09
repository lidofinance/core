// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {IStaking} from "./interfaces/IStaking.sol";
import {StakingVault} from "./StakingVault.sol";
import {ILiquid} from "./interfaces/ILiquid.sol";
import {IConnected} from "./interfaces/IConnected.sol";
import {IHub} from "./interfaces/IHub.sol";

struct Report {
    uint128 value;
    int128 netCashFlow;
}

contract LiquidStakingVault is StakingVault, ILiquid, IConnected {
    IHub public immutable HUB;

    // TODO: unstructured storage
    Report public lastReport;

    uint256 public locked;

    // Is direct validator depositing affects this accounting?
    int256 public netCashFlow;

    constructor(
        address _owner,
        address _vaultController,
        address _depositContract
    ) StakingVault(_owner, _depositContract) {
        HUB = IHub(_vaultController);
    }

    function value() public view override returns (uint256) {
        return uint256(int128(lastReport.value) - lastReport.netCashFlow + netCashFlow);
    }

    function isHealthy() public view returns (bool) {
        return locked <= value();
    }

    function update(uint256 _value, int256 _ncf, uint256 _locked) external {
        if (msg.sender != address(HUB)) revert("ONLY_HUB");

        lastReport = Report(uint128(_value), int128(_ncf)); //TODO: safecast
        locked = _locked;
    }

    function deposit() public payable override(StakingVault) {
        netCashFlow += int256(msg.value);

        super.deposit();
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

    function withdraw(address _receiver, uint256 _amount) public override(StakingVault) {
        require(_amount + locked <= address(this).balance, "NOT_ENOUGH_UNLOCKED_BALANCE");
        require(_receiver != address(0), "ZERO_ADDRESS");
        require(_amount > 0, "ZERO_AMOUNT");

        netCashFlow -= int256(_amount);

        super.withdraw(_receiver, _amount);
    }

    function mintStETH(
        address _receiver,
        uint256 _amountOfShares
    ) external onlyRole(VAULT_MANAGER_ROLE) {
        require(_receiver != address(0), "ZERO_ADDRESS");
        require(_amountOfShares > 0, "ZERO_AMOUNT");
        _mustBeHealthy();

        uint256 newLocked = HUB.mintSharesBackedByVault(_receiver, _amountOfShares);

        if (newLocked > locked) {
            locked = newLocked;
        }

        _mustBeHealthy();
    }

    function burnStETH(
        address _from,
        uint256 _amountOfShares
    ) external onlyRole(VAULT_MANAGER_ROLE) {
        require(_from != address(0), "ZERO_ADDRESS");
        require(_amountOfShares > 0, "ZERO_AMOUNT");
        // burn shares at once but unlock balance later
        HUB.burnSharesBackedByVault(_from, _amountOfShares);
    }

    function shrink(uint256 _amountOfETH) external onlyRole(VAULT_MANAGER_ROLE) {
        require(_amountOfETH > 0, "ZERO_AMOUNT");
        require(address(this).balance >= _amountOfETH, "NOT_ENOUGH_BALANCE");

        // TODO: check rounding here
        // mint some stETH in Lido v2 and burn it on the vault
        HUB.forgive{value: _amountOfETH}();
    }

    function _mustBeHealthy() private view {
        require(locked <= value() , "HEALTH_LIMIT");
    }
}
