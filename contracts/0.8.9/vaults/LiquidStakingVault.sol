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
    uint256 internal constant BPS_IN_100_PERCENT = 10000;

    uint256 public immutable BOND_BP;
    IHub public immutable HUB;

    Report public lastReport;

    uint256 public locked;

    // Is direct validator depositing affects this accounting?
    int256 public netCashFlow;

    constructor(
        address _owner,
        address _vaultController,
        address _depositContract,
        uint256 _bondBP
    ) StakingVault(_owner, _depositContract) {
        HUB = IHub(_vaultController);
        BOND_BP = _bondBP;
    }

    function value() public view override returns (uint256) {
        return uint256(int128(lastReport.value) - lastReport.netCashFlow + netCashFlow);
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

    function createValidators(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public override(StakingVault) {
        _mustBeHealthy();

        super.createValidators(_keysCount, _publicKeysBatch, _signaturesBatch);
    }

    function withdraw(address _receiver, uint256 _amount) public override(StakingVault) {
        netCashFlow -= int256(_amount);
        _mustBeHealthy();

        super.withdraw(_receiver, _amount);
    }

    function isUnderLiquidation() public view returns (bool) {
        return locked > value();
    }

    function mintStETH(address _receiver, uint256 _amountOfShares) external onlyOwner {
        uint256 newLocked =
            uint96((HUB.mintSharesBackedByVault(_receiver, _amountOfShares) * BPS_IN_100_PERCENT) /
            (BPS_IN_100_PERCENT - BOND_BP)); //TODO: SafeCast

        if (newLocked > locked) {
            locked = newLocked;
        }

        _mustBeHealthy();
    }

    function burnStETH(address _from, uint256 _amountOfShares) external onlyOwner {
        // burn shares at once but unlock balance later
        HUB.burnSharesBackedByVault(_from, _amountOfShares);
    }

    function shrink(uint256 _amountOfETH) external onlyOwner {
        // mint some stETH in Lido v2 and burn it on the vault
        HUB.forgive{value: _amountOfETH}();
    }

    function _mustBeHealthy() private view {
        require(locked <= value() , "LIQUIDATION_LIMIT");
    }
}
