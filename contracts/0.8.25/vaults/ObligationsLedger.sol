// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

import {ILido} from "../interfaces/ILido.sol";

import {VaultHub} from "./VaultHub.sol";

import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";

/// @title ObligationsLedger
/// @notice Tracks vaults withdrawals and treasury‑fee obligations.
        contract ObligationsLedger is PausableUntilWithRoles {
    /// @notice obligations that may be accrued by a vault
    struct Obligations {
        uint256 withdrawals;
        uint256 treasuryFees;
    }

    /// @custom:storage-location erc7201:ObligationsLedger
    struct Storage {
        /// @notice obligations for each vault
        mapping(address => Obligations) obligations;
    }

    // keccak256(abi.encode(uint256(keccak256("ObligationsLedger")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xd9c536dea9b3876f46e49cd97c85b0e6c2fcb31eaec75e44ce6d29a7b8245600;

    /// @notice role that allows to accrue withdrawals obligation on the vault
    bytes32 public constant WITHDRAWAL_MANAGER_ROLE = keccak256("vaults.ObligationsLedger.WithdrawalManagerRole");

    ILidoLocator public immutable LIDO_LOCATOR;
    ILido public immutable LIDO;

    constructor(ILidoLocator _lidoLocator, ILido _lido) {
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
    }

    function initialize(address _admin, address _withdrawalManager) external initializer {
        __AccessControlEnumerable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(WITHDRAWAL_MANAGER_ROLE, _withdrawalManager);
    }

    function vaultHub() public view returns (address) {
        return LIDO_LOCATOR.vaultHub();
    }

    function getVaultObligations(address _vault) external view returns (Obligations memory) {
        return _vaultObligations(_vault);
    }

    function getTotalObligationsValue(address _vault) public view returns (uint256) {
        Obligations memory obligations = _vaultObligations(_vault);
        return obligations.withdrawals + obligations.treasuryFees;
    }

    function getWithdrawalsObligation(address _vault) external view returns (uint256) {
        return _vaultObligations(_vault).withdrawals;
    }

    function getTreasuryFeesObligation(address _vault) external view returns (uint256) {
        return _vaultObligations(_vault).treasuryFees;
    }

    function setWithdrawalsObligation(address _vault, uint256 _value) external onlyRole(WITHDRAWAL_MANAGER_ROLE) {
        VaultHub hub = VaultHub(payable(vaultHub()));

        uint256 liability = LIDO.getPooledEthBySharesRoundUp(hub.liabilityShares(_vault));
        if (_value > liability) revert WithdrawalsObligationValueTooHigh(_vault, _value);

        Obligations storage obligations = _vaultObligations(_vault);
        obligations.withdrawals = _value;

        emit WithdrawalsObligationUpdated(_vault, _value);
    }

    function obligationsToSettle(
        address _vault,
        uint256 _fees,
        uint256 _liability
    ) external onlyVaultHub returns (uint256 withdrawals, uint256 treasuryFees) {
        Obligations storage obligations = _vaultObligations(_vault);
        uint256 vaultBalance = _vault.balance;

        // If the vault liability is less than the withdrawals obligation, we need to update the obligation
        if (_liability < obligations.withdrawals) {
            obligations.withdrawals = _liability;
        }

        uint256 valueToRebalance = Math256.min(obligations.withdrawals, vaultBalance);
        uint256 valueToWithdrawAsTreasuryFees = Math256.min(_fees, vaultBalance - valueToRebalance);

        if (valueToRebalance > 0) {
            withdrawals = valueToRebalance;
            obligations.withdrawals -= valueToRebalance;

            emit WithdrawalsObligationSettled(_vault, valueToRebalance, obligations.withdrawals);
        }

        if (valueToWithdrawAsTreasuryFees > 0) {
            treasuryFees = valueToWithdrawAsTreasuryFees;
            obligations.treasuryFees -= valueToWithdrawAsTreasuryFees;

            emit TreasuryFeesObligationSettled(_vault, valueToWithdrawAsTreasuryFees, obligations.treasuryFees);
        }

        if (_fees > valueToWithdrawAsTreasuryFees) {
            obligations.treasuryFees = _fees;

            emit TreasuryFeesObligationUpdated(_vault, _fees);
        }
    }

    function _storage() private pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    function _vaultObligations(address _vault) private view returns (Obligations storage) {
        return _storage().obligations[_vault];
    }

    modifier onlyVaultHub() {
        if (msg.sender != vaultHub()) revert NotAuthorized(msg.sender);
        _;
    }

    error WithdrawalsObligationValueTooHigh(address vault, uint256 amount);

    event WithdrawalsObligationUpdated(address indexed vault, uint256 amount);
    event WithdrawalsObligationSettled(address indexed vault, uint256 amount, uint256 total);

    event TreasuryFeesObligationUpdated(address indexed vault, uint256 amount);
    event TreasuryFeesObligationSettled(address indexed vault, uint256 amount, uint256 total);

    error NotAuthorized(address caller);
}
