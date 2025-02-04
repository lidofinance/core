// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";

import {VaultHub} from "./VaultHub.sol";
import {BeaconValidatorController} from "./BeaconValidatorController.sol";

import {IStakingVault} from "./interfaces/IStakingVault.sol";

/**
 * @title StakingVault
 * @author Lido
 * @notice
 *
 * StakingVault is a private staking pool that enables staking with a designated node operator.
 * Each StakingVault includes an accounting system that tracks its valuation via reports.
 *
 * The StakingVault can be used as a backing for minting new stETH if the StakingVault is connected to the VaultHub.
 * When minting stETH backed by the StakingVault, the VaultHub locks a portion of the StakingVault's valuation,
 * which cannot be withdrawn by the owner. If the locked amount exceeds the StakingVault's valuation,
 * the StakingVault enters the unbalanced state.
 * In this state, the VaultHub can force-rebalance the StakingVault by withdrawing a portion of the locked amount
 * and writing off the locked amount to restore the balanced state.
 * The owner can voluntarily rebalance the StakingVault in any state or by simply
 * supplying more ether to increase the valuation.
 *
 * Access
 * - Owner:
 *   - `fund()`
 *   - `withdraw()`
 *   - `rebalance()`
 *   - `pauseBeaconChainDeposits()`
 *   - `resumeBeaconChainDeposits()`
 *   - `requestValidatorExit()`
 *   - `initiateFullValidatorWithdrawal()`
 *   - `initiatePartialValidatorWithdrawal()`
 * - Operator:
 *   - `depositToBeaconChain()`
 *   - `initiateFullValidatorWithdrawal()`
 *   - `initiatePartialValidatorWithdrawal()`
 * - VaultHub:
 *   - `lock()`
 *   - `report()`
 *   - `rebalance()`
 *   - `forceValidatorWithdrawal()`
 * - Anyone:
 *   - Can send ETH directly to the vault (treated as rewards)
 *
 * BeaconProxy
 * The contract is designed as a beacon proxy implementation, allowing all StakingVault instances
 * to be upgraded simultaneously through the beacon contract. The implementation is petrified
 * (non-initializable) and contains immutable references to the VaultHub and the beacon chain
 * deposit contract.
 *
 */
contract StakingVault is IStakingVault, BeaconValidatorController, OwnableUpgradeable {
    /**
     * @notice ERC-7201 storage namespace for the vault
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom:report Latest report containing valuation and inOutDelta
     * @custom:locked Amount of ether locked on StakingVault by VaultHub and cannot be withdrawn by owner
     * @custom:inOutDelta Net difference between ether funded and withdrawn from StakingVault
     * @custom:nodeOperator Address of the node operator
     * @custom:beaconChainDepositsPaused Whether beacon deposits are paused by the vault owner
     */
    struct ERC7201Storage {
        Report report;
        uint128 locked;
        int128 inOutDelta;
        address nodeOperator;
        bool beaconChainDepositsPaused;
    }

    /**
     * @notice Version of the contract on the implementation
     *         The implementation is petrified to this version
     */
    uint64 private constant _VERSION = 1;

    /**
     * @notice Address of `VaultHub`
     *         Set immutably in the constructor to avoid storage costs
     */
    VaultHub private immutable VAULT_HUB;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         `keccak256(abi.encode(uint256(keccak256("Lido.Vaults.StakingVault")) - 1)) & ~bytes32(uint256(0xff))`
     */
    bytes32 private constant ERC7201_STORAGE_LOCATION =
        0x2ec50241a851d8d3fea472e7057288d4603f7a7f78e6d18a9c12cad84552b100;

    /**
     * @notice Constructs the implementation of `StakingVault`
     * @param _vaultHub Address of `VaultHub`
     * @param _beaconChainDepositContract Address of `BeaconChainDepositContract`
     * @dev Fixes `VaultHub` and `BeaconChainDepositContract` addresses in the bytecode of the implementation
     */
    constructor(
        address _vaultHub,
        address _beaconChainDepositContract
    ) BeaconValidatorController(_beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");

        VAULT_HUB = VaultHub(_vaultHub);

        // Prevents reinitialization of the implementation
        _disableInitializers();
    }

    /**
     * @notice Initializes `StakingVault` with an owner, node operator, and optional parameters
     * @param _owner Address that will own the vault
     * @param _nodeOperator Address of the node operator
     * @param - Additional initialization parameters
     */
    function initialize(address _owner, address _nodeOperator, bytes calldata /* _params */) external initializer {
        __Ownable_init(_owner);
        _getStorage().nodeOperator = _nodeOperator;
    }

    /**
     * @notice Returns the highest version that has been initialized
     * @return Highest initialized version number as uint64
     */
    function getInitializedVersion() external view returns (uint64) {
        return _getInitializedVersion();
    }

    /**
     * @notice Returns the version of the contract
     * @return Version number as uint64
     */
    function version() external pure returns (uint64) {
        return _VERSION;
    }

    // * * * * * * * * * * * * * * * * * * * *  //
    // * * * STAKING VAULT BUSINESS LOGIC * * * //
    // * * * * * * * * * * * * * * * * * * * *  //

    /**
     * @notice Returns the address of `VaultHub`
     * @return Address of `VaultHub`
     */
    function vaultHub() external view returns (address) {
        return address(VAULT_HUB);
    }

    /**
     * @notice Returns the total valuation of `StakingVault`
     * @return Total valuation in ether
     * @dev Valuation = latestReport.valuation + (current inOutDelta - latestReport.inOutDelta)
     */
    function valuation() public view returns (uint256) {
        ERC7201Storage storage $ = _getStorage();
        return uint256(int256(int128($.report.valuation) + $.inOutDelta - $.report.inOutDelta));
    }

    /**
     * @notice Returns the amount of ether locked in `StakingVault`.
     * @return Amount of locked ether
     * @dev Locked amount is updated by `VaultHub` with reports
     *      and can also be increased by `VaultHub` outside of reports
     */
    function locked() external view returns (uint256) {
        return _getStorage().locked;
    }

    /**
     * @notice Returns the unlocked amount, which is the valuation minus the locked amount
     * @return Amount of unlocked ether
     * @dev Unlocked amount is the total amount that can be withdrawn from `StakingVault`,
     *      including ether currently being staked on validators
     */
    function unlocked() public view returns (uint256) {
        uint256 _valuation = valuation();
        uint256 _locked = _getStorage().locked;

        if (_locked > _valuation) return 0;

        return _valuation - _locked;
    }

    /**
     * @notice Returns the net difference between funded and withdrawn ether.
     * @return Delta between funded and withdrawn ether
     * @dev This counter is only updated via:
     *      - `fund()`,
     *      - `withdraw()`,
     *      - `rebalance()` functions.
     *      NB: Direct ether transfers through `receive()` are not accounted for because
     *      those are considered as rewards.
     * @dev This delta will be negative if all funded ether with earned rewards are withdrawn,
     *      i.e. there will be more ether withdrawn than funded (assuming `StakingVault` is profitable).
     */
    function inOutDelta() external view returns (int256) {
        return _getStorage().inOutDelta;
    }

    /**
     * @notice Returns the latest report data for the vault
     * @return Report struct containing valuation and inOutDelta from last report
     */
    function latestReport() external view returns (IStakingVault.Report memory) {
        return _getStorage().report;
    }

    /**
     * @notice Returns the address of the node operator
     *         Node operator is the party responsible for managing the validators.
     *         In the context of this contract, the node operator performs deposits to the beacon chain
     *         and processes validator exit requests submitted by `owner` through `requestValidatorExit()`.
     *         Node operator address is set in the initialization and can never be changed.
     * @return Address of the node operator
     */
    function nodeOperator() external view returns (address) {
        return _getStorage().nodeOperator;
    }

    /**
     * @notice Accepts direct ether transfers
     *         Ether received through direct transfers is not accounted for in `inOutDelta`
     */
    receive() external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
    }

    /**
     * @notice Funds StakingVault with ether
     * @dev Updates inOutDelta to track the net difference between funded and withdrawn ether
     */
    function fund() external payable onlyOwner {
        if (msg.value == 0) revert ZeroArgument("msg.value");

        ERC7201Storage storage $ = _getStorage();
        $.inOutDelta += int128(int256(msg.value));

        emit Funded(msg.sender, msg.value);
    }

    /**
     * @notice Withdraws ether from StakingVault to a specified recipient.
     * @param _recipient Address to receive the withdrawn ether.
     * @param _ether Amount of ether to withdraw.
     * @dev Cannot withdraw more than the unlocked amount or the balance of the contract, whichever is less.
     * @dev Updates inOutDelta to track the net difference between funded and withdrawn ether
     * @dev Includes a check that valuation remains greater than locked amount after withdrawal to ensure
     *      `StakingVault` stays balanced and prevent reentrancy attacks.
     */
    function withdraw(address _recipient, uint256 _ether) external onlyOwner {
        if (_recipient == address(0)) revert ZeroArgument("_recipient");
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);
        uint256 _unlocked = unlocked();
        if (_ether > _unlocked) revert InsufficientUnlocked(_unlocked);

        ERC7201Storage storage $ = _getStorage();
        $.inOutDelta -= int128(int256(_ether));

        (bool success, ) = _recipient.call{value: _ether}("");
        if (!success) revert TransferFailed(_recipient, _ether);

        if (valuation() < $.locked) revert Unbalanced();

        emit Withdrawn(msg.sender, _recipient, _ether);
    }

    /**
     * @notice Locks ether in StakingVault
     * @dev Can only be called by VaultHub; locked amount can only be increased
     * @param _locked New amount to lock
     */
    function lock(uint256 _locked) external {
        if (msg.sender != address(VAULT_HUB)) revert NotAuthorized("lock", msg.sender);

        ERC7201Storage storage $ = _getStorage();
        if ($.locked > _locked) revert LockedCannotDecreaseOutsideOfReport($.locked, _locked);

        $.locked = uint128(_locked);

        emit LockedIncreased(_locked);
    }

    /**
     * @notice Rebalances StakingVault by withdrawing ether to VaultHub
     * @dev Can only be called by VaultHub if StakingVault is unbalanced,
     *      or by owner at any moment
     * @param _ether Amount of ether to rebalance
     */
    function rebalance(uint256 _ether) external {
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);
        uint256 _valuation = valuation();
        if (_ether > _valuation) revert RebalanceAmountExceedsValuation(_valuation, _ether);

        ERC7201Storage storage $ = _getStorage();
        if (owner() == msg.sender || (_valuation < $.locked && msg.sender == address(VAULT_HUB))) {

            $.inOutDelta -= int128(int256(_ether));

            emit Withdrawn(msg.sender, address(VAULT_HUB), _ether);

            VAULT_HUB.rebalance{value: _ether}();
        } else {
            revert NotAuthorized("rebalance", msg.sender);
        }
    }

    /**
     * @notice Submits a report containing valuation, inOutDelta, and locked amount
     * @param _valuation New total valuation: validator balances + StakingVault balance
     * @param _inOutDelta New net difference between funded and withdrawn ether
     * @param _locked New amount of locked ether
     */
    function report(uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        if (msg.sender != address(VAULT_HUB)) revert NotAuthorized("report", msg.sender);

        ERC7201Storage storage $ = _getStorage();

        $.report.valuation = uint128(_valuation);
        $.report.inOutDelta = int128(_inOutDelta);
        $.locked = uint128(_locked);

        emit Reported(_valuation, _inOutDelta, _locked);
    }

    /**
     * @notice Returns the address of `BeaconChainDepositContract`.
     * @return Address of `BeaconChainDepositContract`.
     */
    function depositContract() external view returns (address) {
        return _depositContract();
    }

    /**
     * @notice Returns the 0x02-type withdrawal credentials for the validators deposited from this `StakingVault`.
     *         All CL rewards are sent to this contract. Only 0x02-type withdrawal credentials are supported for now.
     * @return Withdrawal credentials as bytes32.
     */
    function withdrawalCredentials() external view returns (bytes32) {
        return _withdrawalCredentials();
    }

    /**
     * @notice Returns whether deposits are paused by the vault owner.
     * @return True if deposits are paused.
     */
    function beaconChainDepositsPaused() external view returns (bool) {
        return _getStorage().beaconChainDepositsPaused;
    }

    /**
     * @notice Pauses deposits to beacon chain.
     * @dev    Can only be called by the vault owner.
     */
    function pauseBeaconChainDeposits() external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if ($.beaconChainDepositsPaused) {
            revert BeaconChainDepositsResumeExpected();
        }

        $.beaconChainDepositsPaused = true;

        emit BeaconChainDepositsPaused();
    }

    /**
     * @notice Resumes deposits to beacon chain.
     * @dev    Can only be called by the vault owner.
     */
    function resumeBeaconChainDeposits() external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if (!$.beaconChainDepositsPaused) {
            revert BeaconChainDepositsPauseExpected();
        }

        $.beaconChainDepositsPaused = false;

        emit BeaconChainDepositsResumed();
    }

    /**
     * @notice Performs a deposit to the beacon chain deposit contract.
     * @param _deposits Array of deposit structs.
     * @dev    Includes a check to ensure StakingVault is balanced before making deposits.
     */
    function depositToBeaconChain(Deposit[] calldata _deposits) external {
        if (_deposits.length == 0) revert ZeroArgument("_deposits");

        ERC7201Storage storage $ = _getStorage();

        if (msg.sender != $.nodeOperator) revert NotAuthorized("depositToBeaconChain", msg.sender);
        if ($.beaconChainDepositsPaused) revert BeaconChainDepositsArePaused();
        if (valuation() < $.locked) revert Unbalanced();

        _deposit(_deposits);
    }

    /**
     * @notice Returns total withdrawal fee required for given number of validator keys.
     * @param _numberOfKeys Number of validator keys
     * @return Total fee amount
     */
    function calculateValidatorWithdrawalFee(uint256 _numberOfKeys) external view returns (uint256) {
        if (_numberOfKeys == 0) revert ZeroArgument("_numberOfKeys");

        return _calculateWithdrawalFee(_numberOfKeys);
    }

    /**
     * @notice Requests validator exit from the beacon chain.
     * @param _pubkeys Concatenated validator public keys.
     * @dev    Signals the node operator to eject the specified validators from the beacon chain.
     */
    function requestValidatorExit(bytes calldata _pubkeys) external onlyOwner {
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");

        _requestExit(_pubkeys);
    }

    /**
     * @notice Initiates a full validator withdrawal from the beacon chain following EIP-7002.
     * @param _pubkeys Concatenated validators public keys.
     * @dev    Keys are expected to be 48 bytes long tightly packed without paddings.
     *         Only allowed to be called by the owner or the node operator.
     */
    function initiateFullValidatorWithdrawal(bytes calldata _pubkeys) external payable {
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");

        _onlyOwnerOrNodeOperator();
        _initiateFullWithdrawal(_pubkeys);
    }

    /**
     * @notice Initiates a partial validator withdrawal from the beacon chain following EIP-7002.
     * @param _pubkeys Concatenated validators public keys.
     * @param _amounts Amounts of ether to exit.
     * @dev    Keys are expected to be 48 bytes long tightly packed without paddings.
     *         Only allowed to be called by the owner or the node operator.
     */
    function initiatePartialValidatorWithdrawal(bytes calldata _pubkeys, uint64[] calldata _amounts) external payable {
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_amounts.length == 0) revert ZeroArgument("_amounts");

        _onlyOwnerOrNodeOperator();
        _initiatePartialWithdrawal(_pubkeys, _amounts);
    }

    /**
     * @notice Forces validator withdrawal from the beacon chain in case the vault is unbalanced.
     * @param _pubkeys pubkeys of the validators to withdraw.
     * @dev    Can only be called by the vault hub in case the vault is unbalanced.
     */
    function forceValidatorWithdrawal(bytes calldata _pubkeys) external payable override {
        if (msg.sender != address(VAULT_HUB)) revert NotAuthorized("forceValidatorWithdrawal", msg.sender);

        _initiateFullWithdrawal(_pubkeys);
    }

    /**
     * @notice Computes the deposit data root for a validator deposit
     * @param _pubkey Validator public key, 48 bytes
     * @param _withdrawalCredentials Withdrawal credentials, 32 bytes
     * @param _signature Signature of the deposit, 96 bytes
     * @param _amount Amount of ether to deposit, in wei
     * @return Deposit data root as bytes32
     * @dev This function computes the deposit data root according to the deposit contract's specification.
     *      The deposit data root is check upon deposit to the deposit contract as a protection against malformed deposit data.
     *      See more: https://etherscan.io/address/0x00000000219ab540356cbb839cbe05303d7705fa#code
     */
    function computeDepositDataRoot(
        bytes calldata _pubkey,
        bytes calldata _withdrawalCredentials,
        bytes calldata _signature,
        uint256 _amount
    ) external pure returns (bytes32) {
        return _computeDepositDataRoot(_pubkey, _withdrawalCredentials, _signature, _amount);
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    /**
     * @notice Ensures the caller is either the owner or the node operator.
     */
    function _onlyOwnerOrNodeOperator() internal view {
        if (msg.sender != owner() && msg.sender != _getStorage().nodeOperator) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    /**
     * @notice Emitted when `StakingVault` is funded with ether
     * @dev Event is not emitted upon direct transfers through `receive()`
     * @param sender Address that funded the vault
     * @param amount Amount of ether funded
     */
    event Funded(address indexed sender, uint256 amount);

    /**
     * @notice Emitted when ether is withdrawn from `StakingVault`
     * @dev Also emitted upon rebalancing in favor of `VaultHub`
     * @param sender Address that initiated the withdrawal
     * @param recipient Address that received the withdrawn ether
     * @param amount Amount of ether withdrawn
     */
    event Withdrawn(address indexed sender, address indexed recipient, uint256 amount);

    /**
     * @notice Emitted when the locked amount is increased
     * @param locked New amount of locked ether
     */
    event LockedIncreased(uint256 locked);

    /**
     * @notice Emitted when a new report is submitted to `StakingVault`
     * @param valuation Sum of the vault's validator balances and the balance of `StakingVault`
     * @param inOutDelta Net difference between ether funded and withdrawn from `StakingVault`
     * @param locked Amount of ether locked in `StakingVault`
     */
    event Reported(uint256 valuation, int256 inOutDelta, uint256 locked);

    /**
     * @notice Emitted if `owner` of `StakingVault` is a contract and its `onReport` hook reverts
     * @dev Hook used to inform `owner` contract of a new report, e.g. calculating AUM fees, etc.
     * @param reason Revert data from `onReport` hook
     */
    event OnReportFailed(bytes reason);

    /**
     * @notice Emitted when deposits to beacon chain are paused
     */
    event BeaconChainDepositsPaused();

    /**
     * @notice Emitted when deposits to beacon chain are resumed
     */
    event BeaconChainDepositsResumed();

    /**
     * @notice Thrown when an invalid zero value is passed
     * @param name Name of the argument that was zero
     */
    error ZeroArgument(string name);

    /**
     * @notice Thrown when trying to withdraw more ether than the balance of `StakingVault`
     * @param balance Current balance
     */
    error InsufficientBalance(uint256 balance);

    /**
     * @notice Thrown when trying to withdraw more than the unlocked amount
     * @param unlocked Current unlocked amount
     */
    error InsufficientUnlocked(uint256 unlocked);

    /**
     * @notice Thrown when attempting to rebalance more ether than the valuation of `StakingVault`
     * @param valuation Current valuation of the vault
     * @param rebalanceAmount Amount attempting to rebalance
     */
    error RebalanceAmountExceedsValuation(uint256 valuation, uint256 rebalanceAmount);

    /**
     * @notice Thrown when the transfer of ether to a recipient fails
     * @param recipient Address that was supposed to receive the transfer
     * @param amount Amount that failed to transfer
     */
    error TransferFailed(address recipient, uint256 amount);

    /**
     * @notice Thrown when the locked amount is greater than the valuation of `StakingVault`
     */
    error Unbalanced();

    /**
     * @notice Thrown when an unauthorized address attempts a restricted operation
     * @param operation Name of the attempted operation
     * @param sender Address that attempted the operation
     */
    error NotAuthorized(string operation, address sender);

    /**
     * @notice Thrown when attempting to decrease the locked amount outside of a report
     * @param currentlyLocked Current amount of locked ether
     * @param attemptedLocked Attempted new locked amount
     */
    error LockedCannotDecreaseOutsideOfReport(uint256 currentlyLocked, uint256 attemptedLocked);

    /**
     * @notice Thrown when called on the implementation contract
     * @param sender Address that sent the message
     * @param beacon Expected beacon address
     */
    error SenderNotBeacon(address sender, address beacon);

    /**
     * @notice Thrown when the onReport() hook reverts with an Out of Gas error
     */
    error UnrecoverableError();

    /**
     * @notice Thrown when trying to pause deposits to beacon chain while deposits are already paused
     */
    error BeaconChainDepositsPauseExpected();

    /**
     * @notice Thrown when trying to resume deposits to beacon chain while deposits are already resumed
     */
    error BeaconChainDepositsResumeExpected();

    /**
     * @notice Thrown when trying to deposit to beacon chain while deposits are paused
     */
    error BeaconChainDepositsArePaused();
}
