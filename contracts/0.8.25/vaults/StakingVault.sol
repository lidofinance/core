// SPDX-FileCopyrightText: 2024 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.0.2/upgradeable/access/OwnableUpgradeable.sol";
import {ERC1967Utils} from "@openzeppelin/contracts-v5.0.2/proxy/ERC1967/ERC1967Utils.sol";
import {VaultHub} from "./VaultHub.sol";
import {IReportReceiver} from "./interfaces/IReportReceiver.sol";
import {IStakingVault} from "./interfaces/IStakingVault.sol";
import {IBeaconProxy} from "./interfaces/IBeaconProxy.sol";
import {VaultBeaconChainDepositor} from "./VaultBeaconChainDepositor.sol";

/**
 * @title StakingVault
 * @author Lido
 * @notice A staking contract that manages staking operations and ETH deposits to the Beacon Chain
 * @dev
 *
 * ARCHITECTURE & STATE MANAGEMENT
 * ------------------------------
 * The vault uses ERC7201 namespaced storage pattern with a main VaultStorage struct containing:
 * - report: Latest metrics snapshot (valuation and inOutDelta at time of report)
 * - locked: Amount of ETH that cannot be withdrawn (managed by VaultHub)
 * - inOutDelta: The net difference between deposits and withdrawals,
 *               can be negative if withdrawals > deposits due to rewards
 *
 * CORE MECHANICS
 * -------------
 * 1. Deposits & Withdrawals
 *    - Owner can deposit ETH via fund()
 *    - Owner can withdraw unlocked ETH via withdraw()
 *    - All deposits/withdrawals update inOutDelta
 *    - Withdrawals are only allowed if vault remains balanced
 *
 * 2. Valuation & Balance
 *    - Total valuation = report.valuation + (current inOutDelta - report.inOutDelta)
 *    - Vault is "balanced" if total valuation >= locked amount
 *    - Unlocked ETH = max(0, total valuation - locked amount)
 *
 * 3. Beacon Chain Integration
 *    - Can deposit validators (32 ETH each) to Beacon Chain
 *    - Withdrawal credentials are derived from vault address, for now only 0x01 is supported
 *    - Can request validator exits when needed by emitting the event,
 *      which acts as a signal to the operator to exit the validator,
 *      Triggerable Exits are not supported for now
 *
 * 4. Reporting & Updates
 *    - VaultHub periodically updates report data
 *    - Reports capture valuation and inOutDelta at the time of report
 *    - VaultHub can increase locked amount outside of reports
 *
 * 5. Rebalancing
 *    - Owner or VaultHub can trigger rebalancing when unbalanced
 *    - Moves ETH between vault and VaultHub to maintain balance
 *
 * ACCESS CONTROL
 * -------------
 * - Owner: Can fund, withdraw, deposit to beacon chain, request exits, rebalance
 * - VaultHub: Can update reports, lock amounts, force rebalance when unbalanced
 * - Beacon: Controls implementation upgrades
 *
 * SECURITY CONSIDERATIONS
 * ----------------------
 * - Locked amounts can't decrease outside of reports
 * - Withdrawal reverts if it makes vault unbalanced
 * - Only VaultHub can update core state via reports
 * - Uses ERC7201 storage pattern to prevent upgrade collisions
 * - Withdrawal credentials are immutably tied to vault address
 * - This contract uses OpenZeppelin's OwnableUpgradeable which itself inherits Initializable,
 *   thus, this intentionally violates the LIP-10:
 *   https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-10.md
 */
contract StakingVault is IStakingVault, IBeaconProxy, VaultBeaconChainDepositor, OwnableUpgradeable {
    /// @custom:storage-location erc7201:StakingVault.Vault
    /**
     * @dev Main storage structure for the vault
     * @param report Latest report data containing valuation and inOutDelta
     * @param locked Amount of ETH locked in the vault and cannot be withdrawn`
     * @param inOutDelta Net difference between deposits and withdrawals
     */
    struct VaultStorage {
        IStakingVault.Report report;
        uint128 locked;
        int128 inOutDelta;
    }

    uint64 private constant _version = 1;
    VaultHub public immutable VAULT_HUB;

    /// keccak256(abi.encode(uint256(keccak256("StakingVault.Vault")) - 1)) & ~bytes32(uint256(0xff));
    bytes32 private constant VAULT_STORAGE_LOCATION =
        0xe1d42fabaca5dacba3545b34709222773cbdae322fef5b060e1d691bf0169000;

    constructor(
        address _vaultHub,
        address _beaconChainDepositContract
    ) VaultBeaconChainDepositor(_beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");

        VAULT_HUB = VaultHub(_vaultHub);

        _disableInitializers();
    }

    modifier onlyBeacon() {
        if (msg.sender != getBeacon()) revert SenderNotBeacon(msg.sender, getBeacon());
        _;
    }

    /// @notice Initialize the contract storage explicitly.
    ///         The initialize function selector is not changed. For upgrades use `_params` variable
    ///
    /// @param _owner vault owner address
    /// @param _params the calldata for initialize contract after upgrades
    // solhint-disable-next-line no-unused-vars
    function initialize(address _owner, bytes calldata _params) external onlyBeacon initializer {
        __Ownable_init(_owner);
    }

    /**
     * @notice Returns the current version of the contract
     * @return uint64 contract version number
     */
    function version() external pure virtual returns (uint64) {
        return _version;
    }

    /**
     * @notice Returns the version of the contract when it was initialized
     * @return uint64 The initialized version number
     */
    function getInitializedVersion() external view returns (uint64) {
        return _getInitializedVersion();
    }

    /**
     * @notice Returns the address of the VaultHub contract
     * @return address The VaultHub contract address
     */
    function vaultHub() external view returns (address) {
        return address(VAULT_HUB);
    }

    /**
     * @notice Returns the current amount of ETH locked in the vault
     * @return uint256 The amount of locked ETH
     */
    function locked() external view returns (uint256) {
        return _getVaultStorage().locked;
    }

    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
    }

    /**
     * @notice Returns the beacon proxy address that controls this contract's implementation
     * @return address The beacon proxy address
     */
    function getBeacon() public view returns (address) {
        return ERC1967Utils.getBeacon();
    }

    /**
     * @notice Returns the valuation of the vault
     * @return uint256 total valuation in ETH
     * @dev Calculated as:
     *  latestReport.valuation + (current inOutDelta - latestReport.inOutDelta)
     */
    function valuation() public view returns (uint256) {
        VaultStorage storage $ = _getVaultStorage();
        return uint256(int256(int128($.report.valuation) + $.inOutDelta - $.report.inOutDelta));
    }

    /**
     * @notice Returns true if the vault is in a balanced state
     * @return true if valuation >= locked amount
     */
    function isBalanced() public view returns (bool) {
        return valuation() >= _getVaultStorage().locked;
    }

    /**
     * @notice Returns amount of ETH available for withdrawal
     * @return uint256 unlocked ETH that can be withdrawn
     * @dev Calculated as: valuation - locked amount (returns 0 if locked > valuation)
     */
    function unlocked() public view returns (uint256) {
        uint256 _valuation = valuation();
        uint256 _locked = _getVaultStorage().locked;

        if (_locked > _valuation) return 0;

        return _valuation - _locked;
    }

    /**
     * @notice Returns the net difference between deposits and withdrawals
     * @return int256 The current inOutDelta value
     */
    function inOutDelta() external view returns (int256) {
        return _getVaultStorage().inOutDelta;
    }

    /**
     * @notice Returns the withdrawal credentials for Beacon Chain deposits
     * @dev For now only 0x01 is supported
     * @return bytes32 withdrawal credentials derived from vault address
     */
    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
    }

    /**
     * @notice Allows owner to fund the vault with ETH
     * @dev Updates inOutDelta to track the net deposits
     */
    function fund() external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        VaultStorage storage $ = _getVaultStorage();
        $.inOutDelta += int128(int256(msg.value));

        emit Funded(msg.sender, msg.value);
    }

    /**
     * @notice Allows owner to withdraw unlocked ETH
     * @param _recipient Address to receive the ETH
     * @param _ether Amount of ETH to withdraw
     * @dev Checks for sufficient unlocked balance and reverts if unbalanced
     */
    function withdraw(address _recipient, uint256 _ether) external onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);
        uint256 _unlocked = unlocked();
        if (_ether > _unlocked) revert InsufficientUnlocked(_unlocked);

        VaultStorage storage $ = _getVaultStorage();
        $.inOutDelta -= int128(int256(_ether));

        (bool success, ) = _recipient.call{value: _ether}("");
        if (!success) revert TransferFailed(_recipient, _ether);
        if (!isBalanced()) revert Unbalanced();

        emit Withdrawn(msg.sender, _recipient, _ether);
    }

    /**
     * @notice Deposits ETH to the Beacon Chain for validators
     * @param _numberOfDeposits Number of 32 ETH deposits to make
     * @param _pubkeys Validator public keys
     * @param _signatures Validator signatures
     * @dev Ensures vault is balanced and handles deposit logistics
     */
    function depositToBeaconChain(
        uint256 _numberOfDeposits,
        bytes calldata _pubkeys,
        bytes calldata _signatures
    ) external onlyOwner {
        if (_numberOfDeposits == 0) revert ZeroArgument("_numberOfDeposits");
        if (!isBalanced()) revert Unbalanced();

        _makeBeaconChainDeposits32ETH(_numberOfDeposits, bytes.concat(withdrawalCredentials()), _pubkeys, _signatures);
        emit DepositedToBeaconChain(msg.sender, _numberOfDeposits, _numberOfDeposits * 32 ether);
    }

    /**
     * @notice Requests validator exit from the Beacon Chain
     * @param _validatorPublicKey Public key of validator to exit
     */
    function requestValidatorExit(bytes calldata _validatorPublicKey) external onlyOwner {
        // Question: should this be compatible with Lido VEBO?
        emit ValidatorsExitRequest(msg.sender, _validatorPublicKey);
    }

    /**
     * @notice Updates the locked ETH amount
     * @param _locked New amount to lock
     * @dev Can only be called by VaultHub and cannot decrease locked amount
     */
    function lock(uint256 _locked) external {
        if (msg.sender != address(VAULT_HUB)) revert NotAuthorized("lock", msg.sender);

        VaultStorage storage $ = _getVaultStorage();
        if ($.locked > _locked) revert LockedCannotDecreaseOutsideOfReport($.locked, _locked);

        $.locked = uint128(_locked);

        emit Locked(_locked);
    }

    /**
     * @notice Rebalances ETH between vault and VaultHub
     * @param _ether Amount of ETH to rebalance
     * @dev Can be called by owner or VaultHub when unbalanced
     */
    function rebalance(uint256 _ether) external {
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        if (owner() == msg.sender || (!isBalanced() && msg.sender == address(VAULT_HUB))) {
            VaultStorage storage $ = _getVaultStorage();
            $.inOutDelta -= int128(int256(_ether));

            emit Withdrawn(msg.sender, address(VAULT_HUB), _ether);

            VAULT_HUB.rebalance{value: _ether}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    /**
     * @notice Returns the latest report data for the vault
     * @return Report struct containing valuation and inOutDelta from last report
     */
    function latestReport() external view returns (IStakingVault.Report memory) {
        VaultStorage storage $ = _getVaultStorage();
        return $.report;
    }

    /**
     * @notice Updates vault report with new metrics
     * @param _valuation New total valuation
     * @param _inOutDelta New in/out delta
     * @param _locked New locked amount
     * @dev Can only be called by VaultHub
     */
    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (msg.sender != address(VAULT_HUB)) revert NotAuthorized("report", msg.sender);

        VaultStorage storage $ = _getVaultStorage();
        $.report.valuation = uint128(_valuation);
        $.report.inOutDelta = int128(_inOutDelta);
        $.locked = uint128(_locked);

        address _owner = owner();
        uint256 codeSize;
        assembly {
            codeSize := extcodesize(_owner)
        }

        if (codeSize > 0) {
            try IReportReceiver(_owner).onReport(_valuation, _inOutDelta, _locked) {}
            catch (bytes memory reason) {
                emit OnReportFailed(address(this), reason);
            }
        } else {
            emit OnReportFailed(address(this), "");
        }

        emit Reported(address(this), _valuation, _inOutDelta, _locked);
    }

    function _getVaultStorage() private pure returns (VaultStorage storage $) {
        assembly {
            $.slot := VAULT_STORAGE_LOCATION
        }
    }

    event Funded(address indexed sender, uint256 amount);
    event Withdrawn(address indexed sender, address indexed recipient, uint256 amount);
    event DepositedToBeaconChain(address indexed sender, uint256 deposits, uint256 amount);
    event ValidatorsExitRequest(address indexed sender, bytes validatorPublicKey);
    event Locked(uint256 locked);
    event Reported(address indexed vault, uint256 valuation, int256 inOutDelta, uint256 locked);
    event OnReportFailed(address vault, bytes reason);

    error ZeroArgument(string name);
    error InsufficientBalance(uint256 balance);
    error InsufficientUnlocked(uint256 unlocked);
    error TransferFailed(address recipient, uint256 amount);
    error Unbalanced();
    error NotAuthorized(string operation, address sender);
    error LockedCannotDecreaseOutsideOfReport(uint256 currentlyLocked, uint256 attemptedLocked);
    error SenderNotBeacon(address sender, address beacon);
}
