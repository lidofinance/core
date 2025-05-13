// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

import {ILido} from "../interfaces/ILido.sol";

import {VaultHub} from "./VaultHub.sol";

import {PausableUntilWithRoles} from "../utils/PausableUntilWithRoles.sol";

/// @title ObligationsLedger
/// @notice Tracks vaults withdrawals and treasury‑fee obligations.
/// @dev    Invariants enforced:
///         1. accrued >= settled (per obligation).
///         2. accruedWithdrawals ≤ vault liability.
contract ObligationsLedger is PausableUntilWithRoles {
    /// @notice obligations that may be accrued by a vault
    struct Obligations {
        uint256 accruedWithdrawals;
        uint256 settledWithdrawals;
        uint256 accruedTreasuryFees;
        uint256 settledTreasuryFees;
    }

    /// @custom:storage-location erc7201:ObligationsLedger
    struct Storage {
        /// @notice obligations for each vault
        mapping(address => Obligations) obligations;
    }

    // keccak256(abi.encode(uint256(keccak256("ObligationsLedger")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant STORAGE_LOCATION = 0xd9c536dea9b3876f46e49cd97c85b0e6c2fcb31eaec75e44ce6d29a7b8245600;

    /// @notice role that allows to assign a withdrawals obligation
    bytes32 public constant WITHDRAWAL_ASSIGNER_ROLE = keccak256("vaults.ObligationsLedger.WithdrawalAssignerRole");

    /// @notice obligation kind for withdrawals
    bytes32 private constant WITHDRAWALS = keccak256("vaults.ObligationsLedger.Withdrawals");
    /// @notice obligation kind for treasury fees
    bytes32 private constant TREASURY_FEES = keccak256("vaults.ObligationsLedger.TreasuryFees");

    ILidoLocator public immutable LIDO_LOCATOR;
    ILido public immutable LIDO;

    constructor(ILidoLocator _lidoLocator, ILido _lido) {
        LIDO_LOCATOR = _lidoLocator;
        LIDO = _lido;
    }

    function initialize(address _admin, address _withdrawalAssigner) external initializer {
        __AccessControlEnumerable_init();

        _grantRole(DEFAULT_ADMIN_ROLE, _admin);
        _grantRole(WITHDRAWAL_ASSIGNER_ROLE, _withdrawalAssigner);
    }

    function vaultHub() public view returns (address) {
        return LIDO_LOCATOR.vaultHub();
    }

    function getObligations(address _vault) public view returns (Obligations memory obligations) {
        obligations = _storage().obligations[_vault];
    }

    function getWithdrawalsObligationValue(address _vault) public view returns (uint256) {
        return _getWithdrawalsObligationValue(_storage().obligations[_vault]);
    }

    function getTreasuryFeesObligationValue(address _vault) public view returns (uint256) {
        return _getTreasuryFeesObligationValue(_storage().obligations[_vault]);
    }

    function getObligationsValue(address _vault) public view returns (uint256) {
        return _getObligationValue(_storage().obligations[_vault]);
    }

    function _getWithdrawalsObligationValue(Obligations memory o) private view returns (uint256) {
        return o.accruedWithdrawals - o.settledWithdrawals;
    }

    function _getTreasuryFeesObligationValue(Obligations memory o) private view returns (uint256) {
        return o.accruedTreasuryFees - o.settledTreasuryFees;
    }

    function _getObligationValue(Obligations memory o) private view returns (uint256) {
        return _getWithdrawalsObligationValue(o) + _getTreasuryFeesObligationValue(o);
    }

    function assignWithdrawalsObligation(address _vault, uint256 _value) external onlyRole(WITHDRAWAL_ASSIGNER_ROLE) {
        VaultHub hub = VaultHub(payable(vaultHub()));
        uint256 liability = LIDO.getPooledEthBySharesRoundUp(hub.liabilityShares(_vault));
        if (_value > liability) revert ObligationValueTooHigh(_vault, _value);

        _setWithdrawalsObligation(_vault, _value);
    }

    function setWithdrawalsObligation(address _vault, uint256 _outstanding) external onlyVaultHub {
        _setWithdrawalsObligation(_vault, _outstanding);
    }

    function settleWithdrawalsObligation(address _vault, uint256 _settled) external onlyVaultHub {
        _settleWithdrawalsObligation(_vault, _settled);
    }

    function setTreasuryFeesObligation(address _vault, uint256 _outstanding) external onlyVaultHub {
        _setTreasuryFeesObligation(_vault, _outstanding);
    }

    function settleTreasuryFeesObligation(address _vault, uint256 _settled) external onlyVaultHub {
        _settleTreasuryFeesObligation(_vault, _settled);
    }

    function _setWithdrawalsObligation(address _vault, uint256 _value) private {
        Obligations storage o = _storage().obligations[_vault];
        if (_value < o.settledWithdrawals) revert ObligationValueTooLow(_vault, _value);

        o.accruedWithdrawals = o.settledWithdrawals + _value;
        emit ObligationAccrued(_vault, WITHDRAWALS, _value, _getObligationValue(o));
    }

    function _setTreasuryFeesObligation(address _vault, uint256 _value) private {
        Obligations storage o = _storage().obligations[_vault];
        if (_value < o.settledTreasuryFees) revert ObligationValueTooLow(_vault, _value);

        o.accruedTreasuryFees = o.settledTreasuryFees + _value;
        emit ObligationAccrued(_vault, TREASURY_FEES, _value, _getObligationValue(o));
    }

    function _settleWithdrawalsObligation(address _vault, uint256 _value) private {
        Obligations storage o = _storage().obligations[_vault];
        if (_value < o.settledWithdrawals) revert ValueToSettleTooLow(_vault, _value);
        if (_value > o.accruedWithdrawals) revert ValueToSettleTooHigh(_vault, _value);

        o.settledWithdrawals += _value;
        emit ObligationSettled(_vault, WITHDRAWALS, _value, _getObligationValue(o));
    }

    function _settleTreasuryFeesObligation(address _vault, uint256 _value) private {
        Obligations storage o = _storage().obligations[_vault];
        if (_value < o.settledTreasuryFees) revert ValueToSettleTooLow(_vault, _value);
        if (_value > o.accruedTreasuryFees) revert ValueToSettleTooHigh(_vault, _value);

        o.settledTreasuryFees += _value;
        emit ObligationSettled(_vault, TREASURY_FEES, _value, _getObligationValue(o));
    }

    function _storage() private pure returns (Storage storage $) {
        assembly {
            $.slot := STORAGE_LOCATION
        }
    }

    modifier onlyVaultHub() {
        if (msg.sender != vaultHub()) revert NotAuthorized(msg.sender);
        _;
    }

    event ObligationAccrued(address indexed vault, bytes32 indexed kind, uint256 amount, uint256 total);
    event ObligationSettled(address indexed vault, bytes32 indexed kind, uint256 amount, uint256 total);

    error ObligationValueTooHigh(address vault, uint256 amount);
    error ObligationValueTooLow(address vault, uint256 amount);
    error ValueToSettleTooHigh(address vault, uint256 amount);
    error ValueToSettleTooLow(address vault, uint256 amount);
    error NotAuthorized(address caller);
}
