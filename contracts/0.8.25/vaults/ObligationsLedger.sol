// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {AccessControlEnumerableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/extensions/AccessControlEnumerableUpgradeable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

import {ILido} from "../interfaces/ILido.sol";

import {VaultHub} from "./VaultHub.sol";

/// @title ObligationsLedger
/// @notice Tracks vaults withdrawals and treasury‑fee obligations.
contract ObligationsLedger is AccessControlEnumerableUpgradeable {
    /// @notice obligations that may be accrued by a vault
    struct Obligations {
        uint256 unsettledWithdrawals;
        uint256 unsettledTreasuryFees;
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

    function getObligations(address _vault) external view returns (Obligations memory) {
        return _vaultObligations(_vault);
    }

    function getUnsettledObligations(address _vault) external view returns (uint256) {
        return _vaultObligations(_vault).unsettledWithdrawals + _vaultObligations(_vault).unsettledTreasuryFees;
    }

    function getUnsettledWithdrawals(address _vault) external view returns (uint256) {
        return _vaultObligations(_vault).unsettledWithdrawals;
    }

    function getUnsettledTreasuryFees(address _vault) external view returns (uint256) {
        return _vaultObligations(_vault).unsettledTreasuryFees;
    }

    function setUnsettledWithdrawals(address _vault, uint256 _value) external onlyRole(WITHDRAWAL_MANAGER_ROLE) {
        VaultHub hub = VaultHub(payable(vaultHub()));

        uint256 liability = LIDO.getPooledEthBySharesRoundUp(hub.liabilityShares(_vault));
        if (_value > liability) revert WithdrawalsObligationValueTooHigh(_vault, _value);

        _vaultObligations(_vault).unsettledWithdrawals = _value;

        emit WithdrawalsObligationUpdated(_vault, _value);
    }

    function calculateSettlement(
        address _vault,
        uint256 _maxAvailableWithdrawals
    ) external onlyVaultHub returns (uint256 valueToRebalance, uint256 valueToTransferToTreasury) {
        Obligations storage obligations = _vaultObligations(_vault);
        return _getSettlementValues(
            _vault,
            obligations,
            obligations.unsettledTreasuryFees,
            _maxAvailableWithdrawals
        );
    }

    function calculateSettlementOnReport(
        address _vault,
        uint256 _newUnsettledTreasuryFees,
        uint256 _maxAvailableWithdrawals
    ) external onlyVaultHub returns (uint256 valueToRebalance, uint256 valueToTransferToTreasury) {
        return _getSettlementValues(
            _vault,
            _vaultObligations(_vault),
            _newUnsettledTreasuryFees,
            _maxAvailableWithdrawals
        );
    }

    function _getSettlementValues(
        address _vault,
        Obligations storage _obligations,
        uint256 _newUnsettledTreasuryFees,
        uint256 _maxWithdrawals
    ) private returns (uint256 valueToRebalance, uint256 valueToTransferToTreasury) {
        uint256 _vaultBalance = _vault.balance;
        uint256 _newUnsettledWithdrawals = _obligations.unsettledWithdrawals;

        if (_maxWithdrawals < _newUnsettledWithdrawals) {
            _newUnsettledWithdrawals = _maxWithdrawals;
        }

        valueToRebalance = Math256.min(_newUnsettledWithdrawals, _vaultBalance);
        valueToTransferToTreasury = Math256.min(_newUnsettledTreasuryFees, _vaultBalance - valueToRebalance);

        if (valueToRebalance > 0) {
            _obligations.unsettledWithdrawals = _newUnsettledWithdrawals - valueToRebalance;
            emit WithdrawalsObligationSettled(_vault, valueToRebalance, _obligations.unsettledWithdrawals);
        } else {
            if (_newUnsettledWithdrawals != _obligations.unsettledWithdrawals) {
                _obligations.unsettledWithdrawals = _newUnsettledWithdrawals;
                emit WithdrawalsObligationUpdated(_vault, _obligations.unsettledWithdrawals);
            }
        }

        if (valueToTransferToTreasury > 0) {
            _obligations.unsettledTreasuryFees = _newUnsettledTreasuryFees - valueToTransferToTreasury;
            emit TreasuryFeesObligationSettled(_vault, valueToTransferToTreasury, _obligations.unsettledTreasuryFees);
        } else {
            if (_newUnsettledTreasuryFees != _obligations.unsettledTreasuryFees) {
                _obligations.unsettledTreasuryFees = _newUnsettledTreasuryFees;
                emit TreasuryFeesObligationUpdated(_vault, _obligations.unsettledTreasuryFees);
            }
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
    event TreasuryFeesObligationUpdated(address indexed vault, uint256 amount);
    event ObligationsUpdated(address indexed vault, uint256 unsettledWithdrawals, uint256 unsettledTreasuryFees);

    event WithdrawalsObligationSettled(address indexed vault, uint256 amount, uint256 total);
    event TreasuryFeesObligationSettled(address indexed vault, uint256 amount, uint256 total);

    error NotAuthorized(address caller);
}
