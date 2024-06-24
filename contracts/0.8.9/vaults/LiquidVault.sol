// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.9;

import {Basic} from "./interfaces/Basic.sol";
import {BasicVault} from "./BasicVault.sol";
import {Liquid} from "./interfaces/Liquid.sol";
import {Report} from "./interfaces/Connected.sol";
import {Hub} from "./interfaces/Hub.sol";

contract LiquidVault is BasicVault, Liquid {

    uint256 internal constant BPS_IN_100_PERCENT = 10000;

    uint256 public immutable BOND_BP;
    Hub public immutable HUB;

    Report public lastReport;
    // sum(deposits_to_vault) - sum(withdrawals_from_vault)

    // Is direct validator creaction affects this accounting?
    int256 public depositBalance; // ?? better naming
    uint256 public lockedBalance;

    constructor(
        address _owner,
        address _vaultController,
        address _depositContract,
        uint256 _bondBP
    ) BasicVault(_owner, _depositContract) {
        HUB = Hub(_vaultController);
        BOND_BP = _bondBP;
    }

    function getValue() public view override returns (uint256) {
        return lastReport.cl + lastReport.el - lastReport.depositBalance + uint256(depositBalance);
    }

    function update(Report memory _report, uint256 _lockedBalance) external {
        if (msg.sender != address(HUB)) revert("ONLY_HUB");

        lastReport = _report;
        lockedBalance = _lockedBalance;
    }

    receive() external payable override(BasicVault, Basic) {
        depositBalance += int256(msg.value);
    }

    function deposit(
        uint256 _keysCount,
        bytes calldata _publicKeysBatch,
        bytes calldata _signaturesBatch
    ) public override(BasicVault, Basic) {
        _mustBeHealthy();

        super.deposit(_keysCount, _publicKeysBatch, _signaturesBatch);
    }

    function withdraw(address _receiver, uint256 _amount) public override(Basic, BasicVault) {
        depositBalance -= int256(_amount);
        _mustBeHealthy();

        super.withdraw(_receiver, _amount);
    }

    function isUnderLiquidation() public view returns (bool) {
        return lockedBalance > getValue();
    }

    function mintStETH(address _receiver, uint256 _amountOfShares) external onlyOwner {
        lockedBalance =
            uint96((HUB.mintSharesBackedByVault(_receiver, _amountOfShares) * BPS_IN_100_PERCENT) /
            (BPS_IN_100_PERCENT - BOND_BP)); //TODO: SafeCast

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

    function _mustBeHealthy() view private {
        require(lockedBalance <= getValue() , "LIQUIDATION_LIMIT");
    }
}
