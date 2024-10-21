// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {Vault} from "./Vault.sol";
import {IHub, ILiquidVault} from "./interfaces/ILiquidVault.sol";

// TODO: add erc-4626-like can* methods
// TODO: add sanity checks
contract LiquidVault is ILiquidVault, Vault {
    uint256 private constant MAX_FEE = 10000;

    IHub private immutable hub;

    Report private latestReport;

    uint256 private locked;
    int256 private inOutDelta; // Is direct validator depositing affects this accounting?

    uint256 private managementFee;
    uint256 private managementDue;

    constructor(address _hub, address _owner, address _depositContract) Vault(_owner, _depositContract) {
        hub = IHub(_hub);
    }

    function getHub() external view returns (IHub) {
        return hub;
    }

    function getLatestReport() external view returns (Report memory) {
        return latestReport;
    }

    function getLocked() external view returns (uint256) {
        return locked;
    }

    function getInOutDelta() external view returns (int256) {
        return inOutDelta;
    }

    function getManagementFee() external view returns (uint256) {
        return managementFee;
    }

    function getManagementDue() external view returns (uint256) {
        return managementDue;
    }

    function valuation() public view returns (uint256) {
        return uint256(int128(latestReport.valuation) + inOutDelta - latestReport.inOutDelta);
    }

    function isHealthy() public view returns (bool) {
        return locked <= valuation();
    }

    function getWithdrawableAmount() public view returns (uint256) {
        if (locked > valuation()) return 0;

        return valuation() - locked;
    }

    function fund() public payable override(Vault) {
        inOutDelta += int256(msg.value);

        super.fund();
    }

    function withdraw(address _recipient, uint256 _ether) public override(Vault) {
        if (_recipient == address(0)) revert Zero("_recipient");
        if (_ether == 0) revert Zero("_ether");
        if (getWithdrawableAmount() < _ether) revert InsufficientUnlocked(getWithdrawableAmount(), _ether);

        inOutDelta -= int256(_ether);
        super.withdraw(_recipient, _ether);

        _revertIfNotHealthy();
    }

    function deposit(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) public override(Vault) {
        // unhealthy vaults are up to force rebalancing
        // so, we don't want it to send eth back to the Beacon Chain
        _revertIfNotHealthy();

        super.deposit(_numberOfDeposits, _pubkeys, _signatures);
    }

    function mint(address _recipient, uint256 _tokens) external payable onlyOwner {
        if (_recipient == address(0)) revert Zero("_recipient");
        if (_tokens == 0) revert Zero("_shares");

        uint256 newlyLocked = hub.mintStethBackedByVault(_recipient, _tokens);

        if (newlyLocked > locked) {
            locked = newlyLocked;

            emit Locked(newlyLocked);
        }
    }

    function burn(uint256 _tokens) external onlyOwner {
        if (_tokens == 0) revert Zero("_tokens");

        // burn shares at once but unlock balance later during the report
        hub.burnStethBackedByVault(_tokens);
    }

    function rebalance(uint256 _ether) external payable {
        if (_ether == 0) revert Zero("_ether");
        if (address(this).balance < _ether) revert InsufficientBalance(address(this).balance);

        if (owner() == msg.sender || (!isHealthy() && msg.sender == address(hub))) {
            // force rebalance
            // TODO: check rounding here
            // mint some stETH in Lido v2 and burn it on the vault
            inOutDelta -= int256(_ether);
            emit Withdrawn(msg.sender, msg.sender, _ether);

            hub.rebalance{value: _ether}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    function update(uint256 _value, int256 _ncf, uint256 _locked) external {
        if (msg.sender != address(hub)) revert NotAuthorized("update", msg.sender);

        latestReport = Report(uint128(_value), int128(_ncf)); //TODO: safecast
        locked = _locked;

        managementDue += (_value * managementFee) / 365 / MAX_FEE;

        emit Reported(_value, _ncf, _locked);
    }

    function _revertIfNotHealthy() private view {
        if (!isHealthy()) revert NotHealthy(locked, valuation());
    }
}
