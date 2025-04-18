// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {TriggerableWithdrawals} from "contracts/common/lib/TriggerableWithdrawals.sol";

import {VaultHub} from "./VaultHub.sol";
import {PinnedBeaconUtils} from "./lib/PinnedBeaconUtils.sol";

import {IDepositContract} from "../interfaces/IDepositContract.sol";
import {IStakingVault, StakingVaultDeposit} from "./interfaces/IStakingVault.sol";

/**
 * @title StakingVault
 * @author Lido
 * @notice
 *
 * StakingVault is a private staking pool that enables staking with a designated node operator.
 * Each StakingVault includes an accounting system that tracks its valuation via reports.
 *
 * The StakingVault can be used as a backing for minting new stETH through integration with the VaultHub.
 * When minting stETH backed by the StakingVault, the VaultHub designates a portion of the StakingVault's
 * valuation as locked, which cannot be withdrawn by the owner. This locked portion represents the
 * backing for the minted stETH.
 *
 * If the locked amount exceeds the StakingVault's current valuation, the VaultHub has the ability to
 * rebalance the StakingVault. This rebalancing process involves withdrawing a portion of the staked amount
 * and adjusting the locked amount to align with the current valuation.
 *
 * The owner may proactively maintain the vault's backing ratio by either:
 * - Voluntarily rebalancing the StakingVault at any time
 * - Adding more ether to increase the valuation
 * - Triggering validator withdrawals to increase the valuation
 *
 * Access
 * - Owner:
 *   - `fund()`
 *   - `withdraw()`
 *   - `rebalance()`
 *   - `lock()`
 *   - `pauseBeaconChainDeposits()`
 *   - `resumeBeaconChainDeposits()`
 *   - `requestValidatorExit()`
 *   - `triggerValidatorWithdrawal()`
 *   - `authorizeLidoVaultHub()`
 *   - `deauthorizeLidoVaultHub()`
 *   - `ossifyStakingVault()`
 *   - `setDepositor()`
 *   - `resetLocked()`
 * - Operator:
 *   - `triggerValidatorWithdrawal()`
 * - Depositor:
 *   - `depositToBeaconChain()`
 * - VaultHub:
 *   - `report()`
 *   - `rebalance()`
 *   - `triggerValidatorWithdrawal()`
 * - Anyone:
 *   - Can send ETH directly to the vault (treated as rewards)
 *
 * PinnedBeaconProxy
 * The contract is designed as an extended beacon proxy implementation, allowing individual StakingVault instances
 * to be ossified (pinned) to prevent future upgrades. The implementation is petrified (non-initializable)
 * and contains immutable references to the beacon chain deposit contract.
 *
 */
contract StakingVault is IStakingVault, OwnableUpgradeable {
    /**
     * @notice ERC-7201 storage namespace for the vault
     * @dev ERC-7201 namespace is used to prevent upgrade collisions
     * @custom:report Latest report containing valuation and inOutDelta
     * @custom:locked Amount of ether locked on StakingVault by VaultHub and cannot be withdrawn by owner
     * @custom:inOutDelta Net difference between ether funded and withdrawn from StakingVault
     * @custom:nodeOperator Address of the node operator
     * @custom:depositor Address of the depositor
     * @custom:vaultHubAuthorized Whether the vaultHub is authorized at the vault
     * @custom:beaconChainDepositsPaused Whether beacon deposits are paused by the vault owner
     */
    struct ERC7201Storage {
        Report report;
        uint128 locked;
        int128 inOutDelta;
        address nodeOperator;
        address depositor;
        bool vaultHubAuthorized;
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
     * @notice Address of `BeaconChainDepositContract`
     *         Set immutably in the constructor to avoid storage costs
     */
    IDepositContract public immutable DEPOSIT_CONTRACT;

    /**
     * @notice The type of withdrawal credentials for the validators deposited from this `StakingVault`.
     */
    uint256 private constant WC_0X02_PREFIX = 0x02 << 248;

    /**
     * @notice The length of the public key in bytes
     */
    uint256 public constant PUBLIC_KEY_LENGTH = 48;

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
    constructor(address _vaultHub, address _beaconChainDepositContract) {
        if (_vaultHub == address(0)) revert ZeroArgument("_vaultHub");
        if (_beaconChainDepositContract == address(0)) revert ZeroArgument("_beaconChainDepositContract");

        VAULT_HUB = VaultHub(_vaultHub);
        DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);

        // Prevents reinitialization of the implementation
        _disableInitializers();
    }

    /**
     * @notice Initializes `StakingVault` with an owner, node operator, and optional parameters
     * @param _owner Address that will own the vault
     * @param _nodeOperator Address of the node operator
     * @param _depositor Address of the depositor. If zero address, _nodeOperator will be used
     * @param - Additional initialization parameters
     */
    function initialize(
        address _owner,
        address _nodeOperator,
        address _depositor,
        bytes calldata /* _params */
    ) external initializer {
        if (_nodeOperator == address(0)) revert ZeroArgument("_nodeOperator");

        __Ownable_init(_owner);

        ERC7201Storage storage $ = _getStorage();
        $.nodeOperator = _nodeOperator;
        $.depositor = _depositor == address(0) ? _nodeOperator : _depositor;

        emit NodeOperatorSet(_nodeOperator);
        emit DepositorSet(_depositor);
    }

    /**
     * @notice Returns the highest version that has been initialized as uint64
     */
    function getInitializedVersion() external view returns (uint64) {
        return _getInitializedVersion();
    }

    /**
     * @notice Returns the version of the contract as uint64
     */
    function version() external pure returns (uint64) {
        return _VERSION;
    }

    /**
     * @notice returns owner of the contract
     * @dev fixes solidity interface inference
     */
    function owner() public view override(IStakingVault, OwnableUpgradeable) returns (address) {
        return OwnableUpgradeable.owner();
    }

    // * * * * * * * * * * * * * * * * * * * *  //
    // * * * STAKING VAULT BUSINESS LOGIC * * * //
    // * * * * * * * * * * * * * * * * * * * *  //

    /**
     * @notice Returns the address of `VaultHub`
     */
    function vaultHub() external view returns (address) {
        return address(VAULT_HUB);
    }

    /**
     * @notice Authorizes the `VaultHub` at the vault
     * @dev Can only be called by the owner
     * @dev Reverts if vaultHub is already authorized
     * @dev Reverts if vault is ossified
     * @dev Reverts if the depositor is not the Lido Predeposit Guarantee
     */
    function authorizeLidoVaultHub() external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if ($.vaultHubAuthorized) revert VaultHubAuthorized();
        if (ossified()) revert VaultOssified();

        address lidoPredepositGuarantee = VaultHub(VAULT_HUB).LIDO_LOCATOR().predepositGuarantee();
        if ($.depositor != lidoPredepositGuarantee) revert InvalidDepositor($.depositor);

        $.vaultHubAuthorized = true;

        emit VaultHubAuthorizedSet(true);
    }

    /**
     * @notice Deauthorizes the `VaultHub` from the vault
     * @dev Can only be called by the owner
     * @dev Reverts if vaultHub is already deauthorized
     * @dev Reverts if vault is already connected to VaultHub
     */
    function deauthorizeLidoVaultHub() external onlyOwner {
        VaultHub.VaultSocket memory socket = VaultHub(VAULT_HUB).vaultSocket(address(this));
        if (socket.vault != address(0)) {
            revert VaultConnected();
        }

        ERC7201Storage storage $ = _getStorage();
        if (!$.vaultHubAuthorized) revert VaultHubNotAuthorized();

        $.vaultHubAuthorized = false;

        emit VaultHubAuthorizedSet(false);
    }

    /**
     * @notice Returns true if the vault is attached to VaultHub
     * @return True if the vault is attached to VaultHub, false otherwise
     */
    function vaultHubAuthorized() external view returns (bool) {
        return _getStorage().vaultHubAuthorized;
    }

    /**
     * @notice Ossifies the current implementation. WARNING: This operation is irreversible,
     *         once ossified, the vault cannot be upgraded or attached to VaultHub.
     * @dev Can only be called by the owner.
     *      Pins the current vault implementation to prevent further upgrades.
     *      Emits an event `PinnedImplementationUpdated` with the current implementation address.
     * @dev Reverts if already ossified.
     * @dev Reverts if vaultHub is authorized at the vault
     */
    function ossifyStakingVault() external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if ($.vaultHubAuthorized) revert VaultHubAuthorized();
        PinnedBeaconUtils.ossify();
    }

    /**
     * @notice Returns true if the vault is ossified
     * @return True if the vault is ossified, false otherwise
     */
    function ossified() public view returns (bool) {
        return PinnedBeaconUtils.ossified();
    }

    /**
     * @notice Returns the total valuation of `StakingVault` in ether
     * @dev Valuation = latestReport.valuation + (current inOutDelta - latestReport.inOutDelta)
     */
    function valuation() public view returns (uint256) {
        ERC7201Storage storage $ = _getStorage();
        return uint256(int256(int128($.report.valuation) + $.inOutDelta - $.report.inOutDelta));
    }

    /**
     * @notice Returns the amount of ether locked in `StakingVault` in ether
     * @dev Locked amount is updated by `VaultHub` with reports
     *      and can also be increased by `VaultHub` outside of reports
     */
    function locked() external view returns (uint256) {
        return _getStorage().locked;
    }

    /**
     * @notice Returns the unlocked amount of ether, which is the valuation minus the locked ether amount
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
     * @notice Resets the locked amount to 0 only when the vaultHub is deauthorized
     * @dev Can only be called by the owner
     * @dev Reverts if vaultHub is authorized at the vault
     */
    function resetLocked() external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if ($.vaultHubAuthorized) revert VaultHubAuthorized();
        _getStorage().locked = 0;

        emit LockedReset();
    }

    /**
     * @notice Returns the net difference between funded and withdrawn ether.
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
     * @notice Returns the latest report data for the vault (valuation and inOutDelta)
     */
    function latestReport() external view returns (IStakingVault.Report memory) {
        return _getStorage().report;
    }

    /**
     * @notice Returns the address of the node operator
     *         Node operator is the party responsible for managing the validators.
     *         Node operator address is set in the initialization and can never be changed.
     */
    function nodeOperator() external view returns (address) {
        return _getStorage().nodeOperator;
    }

    /**
     * @notice Returns the address of the depositor
     *         Trusted party responsible for securely depositing validators to the beacon chain, e.g.
     *         securing against deposit frontrun vulnerability in ethereum deposit contract
     *         (for reference see LIP-5 - https://research.lido.fi/t/lip-5-mitigations-for-deposit-front-running-vulnerability/1269).
     *         In the context of this contract, the depositor performs deposits through `depositToBeaconChain()`.
     * @return Address of the depositor
     */
    function depositor() external view returns (address) {
        return _getStorage().depositor;
    }

    /**
     * @notice Sets the address of the depositor
     * @dev Can only be called by the owner
     * @dev Reverts if the `_depositor` is the zero address
     * @dev Reverts if the vault is attached to VaultHub
     */
    function setDepositor(address _depositor) external onlyOwner {
        if (_depositor == address(0)) revert ZeroArgument("_depositor");

        ERC7201Storage storage $ = _getStorage();
        if ($.vaultHubAuthorized) revert VaultHubAuthorized();
        $.depositor = _depositor;
        emit DepositorSet(_depositor);
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
     * @dev Updates inOutDelta to track the net difference between funded and withdrawn ether.
     * @dev Checks that valuation remains greater or equal than locked amount and prevents reentrancy attacks.
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

        if (isReportFresh()) {
            if (valuation() < $.locked) revert ValuationBelowLockedAmount();
        } else {
            if (address(this).balance < $.locked) revert ValuationBelowLockedAmount();
        }

        emit Withdrawn(msg.sender, _recipient, _ether);
    }

    /**
     * @notice Locks ether in StakingVault
     * @dev Can only be called by owner; locked amount can only be increased
     * @param _locked New amount to lock
     */
    function lock(uint256 _locked) external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if (_locked <= $.locked) revert NewLockedNotGreaterThanCurrent();
        if (isReportFresh()) {
            if (_locked > valuation()) revert NewLockedExceedsValuation();
        } else {
            if (_locked > address(this).balance) revert NewLockedExceedsValuation();
        }

        $.locked = uint128(_locked);

        emit LockedIncreased(_locked);
    }

    /**
     * @notice Rebalances StakingVault by withdrawing ether to VaultHub
     * @dev Can only be called by VaultHub if StakingVault valuation is less than locked amount
     * @param _ether Amount of ether to rebalance
     */
    function rebalance(uint256 _ether) external {
        if (_ether == 0) revert ZeroArgument("_ether");
        if (_ether > address(this).balance) revert InsufficientBalance(address(this).balance);

        uint256 valuation_ = valuation();
        if (_ether > valuation_) revert RebalanceAmountExceedsValuation(valuation_, _ether);

        ERC7201Storage storage $ = _getStorage();

        bool isAuthorized = (owner() == msg.sender
            || (valuation_ < $.locked && msg.sender == address(VAULT_HUB) && $.vaultHubAuthorized)
        );
        if (!isAuthorized) revert NotAuthorized("rebalance", msg.sender);

        $.inOutDelta -= int128(int256(_ether));

        emit Withdrawn(msg.sender, address(VAULT_HUB), _ether);

        VAULT_HUB.rebalance{value: _ether}();
    }

    /**
     * @notice Submits a report containing valuation, inOutDelta, and locked amount
     * @param _valuation New total valuation: validator balances + StakingVault balance
     * @param _inOutDelta New net difference between funded and withdrawn ether
     * @param _locked New amount of locked ether
     */
    function report(uint64 _timestamp, uint256 _valuation, int256 _inOutDelta, uint256 _locked) external {
        ERC7201Storage storage $ = _getStorage();
        if (msg.sender != address(VAULT_HUB) || !$.vaultHubAuthorized) revert NotAuthorized("report", msg.sender);

        uint64 currentTimestamp = $.report.timestamp;
        if (currentTimestamp >= _timestamp) revert ReportTooOld(currentTimestamp, _timestamp);

        $.report.timestamp = _timestamp;
        $.report.valuation = uint128(_valuation);
        $.report.inOutDelta = int128(_inOutDelta);
        $.locked = uint128(_locked);

        emit Reported(_timestamp, _valuation, _inOutDelta, _locked);
    }

    /**
     * @notice Returns the 0x02-type withdrawal credentials for the validators deposited from this `StakingVault`
     *         All consensus layer rewards are sent to this contract. Only 0x02-type withdrawal credentials are supported
     */
    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32(WC_0X02_PREFIX | uint160(address(this)));
    }

    /**
     * @notice Returns whether deposits are paused
     */
    function beaconChainDepositsPaused() external view returns (bool) {
        return _getStorage().beaconChainDepositsPaused;
    }

    /**
     * @notice Pauses deposits to beacon chain
     * @dev    Can only be called by the vault owner
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
     * @notice Resumes deposits to beacon chain
     * @dev    Can only be called by the vault owner
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
     * @notice Performs a deposit to the beacon chain deposit contract
     * @param _deposits Array of deposit structs
     * @dev Can only be called by the depositor address
     * @dev Includes a check to ensure `StakingVault` valuation is not less than locked before making deposits
     */
    function depositToBeaconChain(StakingVaultDeposit[] calldata _deposits) external {
        if (_deposits.length == 0) revert ZeroArgument("_deposits");

        ERC7201Storage storage $ = _getStorage();
        if ($.beaconChainDepositsPaused) revert BeaconChainDepositsArePaused();
        if (msg.sender != $.depositor) revert NotAuthorized("depositToBeaconChain", msg.sender);
        if (valuation() < $.locked) revert ValuationBelowLockedAmount();

        uint256 numberOfDeposits = _deposits.length;
        uint256 totalAmount = 0;
        bytes memory withdrawalCredentials_ = bytes.concat(withdrawalCredentials());

        for (uint256 i = 0; i < numberOfDeposits; i++) {
            StakingVaultDeposit calldata deposit = _deposits[i];

            DEPOSIT_CONTRACT.deposit{value: deposit.amount}(
                deposit.pubkey,
                withdrawalCredentials_,
                deposit.signature,
                deposit.depositDataRoot
            );

            totalAmount += deposit.amount;
        }

        emit DepositedToBeaconChain(msg.sender, numberOfDeposits, totalAmount);
    }

    /**
     * @notice Calculates the total withdrawal fee required for given number of validator keys
     * @param _numberOfKeys Number of validators' public keys
     * @return Total fee amount to pass as `msg.value` (wei)
     * @dev    The fee is only valid for the requests made in the same block
     */
    function calculateValidatorWithdrawalFee(uint256 _numberOfKeys) external view returns (uint256) {
        if (_numberOfKeys == 0) revert ZeroArgument("_numberOfKeys");

        return _numberOfKeys * TriggerableWithdrawals.getWithdrawalRequestFee();
    }

    /**
     * @notice Requests node operator to exit validators from the beacon chain
     *         It does not directly trigger exits - node operators must monitor for these events and handle the exits
     * @param _pubkeys Concatenated validator public keys, each 48 bytes long
     */
    function requestValidatorExit(bytes calldata _pubkeys) external onlyOwner {
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_pubkeys.length % PUBLIC_KEY_LENGTH != 0) {
            revert InvalidPubkeysLength();
        }

        uint256 keysCount = _pubkeys.length / PUBLIC_KEY_LENGTH;
        for (uint256 i = 0; i < keysCount; i++) {
            bytes memory pubkey = _pubkeys[i * PUBLIC_KEY_LENGTH:(i + 1) * PUBLIC_KEY_LENGTH];
            emit ValidatorExitRequested(msg.sender, /* indexed */ pubkey, pubkey);
        }
    }

    /**
     * @notice Triggers validator withdrawals from the beacon chain using EIP-7002 triggerable exit
     * @param _pubkeys Concatenated validators public keys, each 48 bytes long
     * @param _amounts Amounts of ether to exit, must match the length of _pubkeys
     * @param _refundRecipient Address to receive the fee refund, if zero, refunds go to msg.sender
     * @dev    The caller must provide sufficient fee via msg.value to cover the withdrawal request costs
     */
    function triggerValidatorWithdrawal(
        bytes calldata _pubkeys,
        uint64[] calldata _amounts,
        address _refundRecipient
    ) external payable {
        if (msg.value == 0) revert ZeroArgument("msg.value");
        if (_pubkeys.length == 0) revert ZeroArgument("_pubkeys");
        if (_amounts.length == 0) revert ZeroArgument("_amounts");

        // If the refund recipient is not set, use the sender as the refund recipient
        if (_refundRecipient == address(0)) {
            _refundRecipient = msg.sender;
        }

        ERC7201Storage storage $ = _getStorage();

        bool isAuthorized = msg.sender == $.nodeOperator || msg.sender == owner();

        // Authorize VaultHub to initiate forced validator exits when valuation is below locked amount
        bool isValuationBelowLocked = valuation() < $.locked;
        if (isValuationBelowLocked) {
            isAuthorized = isAuthorized || (msg.sender == address(VAULT_HUB) && $.vaultHubAuthorized);
        }
        if (!isAuthorized) revert NotAuthorized("triggerValidatorWithdrawal", msg.sender);

        // Block partial withdrawals when valuation is below locked amount or report is stale
        // This is to prevent forced validator exits from front-running with partial withdrawals
        if (isValuationBelowLocked || !isReportFresh()) {
            for (uint256 i = 0; i < _amounts.length; i++) {
                if (_amounts[i] > 0) revert PartialWithdrawalNotAllowed();
            }
        }

        uint256 feePerRequest = TriggerableWithdrawals.getWithdrawalRequestFee();
        uint256 totalFee = (_pubkeys.length / PUBLIC_KEY_LENGTH) * feePerRequest;
        if (msg.value < totalFee) revert InsufficientValidatorWithdrawalFee(msg.value, totalFee);

        TriggerableWithdrawals.addWithdrawalRequests(_pubkeys, _amounts, feePerRequest);

        uint256 excess = msg.value - totalFee;
        if (excess > 0) {
            (bool success, ) = _refundRecipient.call{value: excess}("");
            if (!success) revert WithdrawalFeeRefundFailed(_refundRecipient, excess);
        }

        emit ValidatorWithdrawalTriggered(msg.sender, _pubkeys, _amounts, _refundRecipient, excess);
    }

    function isReportFresh() public view returns (bool) {
        ERC7201Storage storage $ = _getStorage();
        if (!$.vaultHubAuthorized) return true;
        return block.timestamp - $.report.timestamp < VAULT_HUB.REPORT_FRESHNESS_DELTA();
    }

    function _checkFreshnessAndGetValuation() internal view returns (uint256) {
        if (!isReportFresh()) revert ReportStaled();
        return valuation();
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC7201_STORAGE_LOCATION
        }
    }

    /**
     * @notice Emitted when `NodeOperator` is set
     * @param nodeOperator Address of the set `NodeOperator`
     */
    event NodeOperatorSet(address indexed nodeOperator);

    /**
     * @notice Emitted when `Depositor` is attached
     * @param depositor Address of the attached `Depositor`
     */
    event DepositorSet(address indexed depositor);

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
     * @notice Emitted when the locked amount is reset to 0
     */
    event LockedReset();

    /**
     * @notice Emitted when a new report is submitted to `StakingVault`
     * @param valuation Sum of the vault's validator balances and the balance of `StakingVault`
     * @param inOutDelta Net difference between ether funded and withdrawn from `StakingVault`
     * @param locked Amount of ether locked in `StakingVault`
     */
    event Reported(uint64 indexed timestamp, uint256 valuation, int256 inOutDelta, uint256 locked);

    /**
     * @notice Emitted when deposits to beacon chain are paused
     */
    event BeaconChainDepositsPaused();

    /**
     * @notice Emitted when deposits to beacon chain are resumed
     */
    event BeaconChainDepositsResumed();

    /**
     * @notice Emitted when ether is deposited to `DepositContract`.
     * @param _sender Address that initiated the deposit.
     * @param _deposits Number of validator deposits made.
     * @param _totalAmount Total amount of ether deposited.
     */
    event DepositedToBeaconChain(address indexed _sender, uint256 _deposits, uint256 _totalAmount);

    /**
     * @notice Emitted when vault owner requests node operator to exit validators from the beacon chain
     * @param _sender Address that requested the exit
     * @param _pubkey Indexed public key of the validator to exit
     * @param _pubkeyRaw Raw public key of the validator to exit
     * @dev    Signals to node operators that they should exit this validator from the beacon chain
     */
    event ValidatorExitRequested(address _sender, bytes indexed _pubkey, bytes _pubkeyRaw);

    /**
     * @notice Emitted when validator withdrawals are requested via EIP-7002
     * @param _sender Address that requested the withdrawals
     * @param _pubkeys Concatenated public keys of the validators to withdraw
     * @param _amounts Amounts of ether to withdraw per validator
     * @param _refundRecipient Address to receive any excess withdrawal fee
     * @param _excess Amount of excess fee refunded to recipient
     */
    event ValidatorWithdrawalTriggered(
        address indexed _sender,
        bytes _pubkeys,
        uint64[] _amounts,
        address _refundRecipient,
        uint256 _excess
    );

    /**
     * @notice Emitted when `VaultHub` is authorized or deauthorized from `StakingVault`
     * @param authorized True if `VaultHub` is authorized, false otherwise
     */
    event VaultHubAuthorizedSet(bool authorized);

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
     * @notice Thrown when the valuation of the vault falls below the locked amount
     */
    error ValuationBelowLockedAmount();

    /**
     * @notice Thrown when an unauthorized address attempts a restricted operation
     * @param operation Name of the attempted operation
     * @param sender Address that attempted the operation
     */
    error NotAuthorized(string operation, address sender);

    /**
     * @notice Thrown when attempting to decrease the locked amount outside of a report
     */
    error NewLockedNotGreaterThanCurrent();

    /**
     * @notice Thrown when the locked amount exceeds the valuation
     */
    error NewLockedExceedsValuation();

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

    /**
     * @notice Thrown when the length of the validator public keys is invalid
     */
    error InvalidPubkeysLength();

    /**
     * @notice Thrown when the validator withdrawal fee is insufficient
     * @param _passed Amount of ether passed to the function
     * @param _required Amount of ether required to cover the fee
     */
    error InsufficientValidatorWithdrawalFee(uint256 _passed, uint256 _required);

    /**
     * @notice Thrown when a validator withdrawal fee refund fails
     * @param _sender Address that initiated the refund
     * @param _amount Amount of ether to refund
     */
    error WithdrawalFeeRefundFailed(address _sender, uint256 _amount);

    /**
     * @notice Thrown when partial withdrawals are not allowed when valuation is below locked
     */
    error PartialWithdrawalNotAllowed();

    /**
     * @notice Thrown when trying to deauthorize vaultHub while it is not authorized
     */
    error VaultHubNotAuthorized();

    /**
     * @notice Thrown when trying to ossify vault, or to attach vault to VaultHub while it is already attached
     */
    error VaultHubAuthorized();

    /**
     * @notice Thrown when trying to attach vault to VaultHub while it is ossified
     */
    error VaultOssified();

    /**
     * @notice Thrown when a report is staled
     */
    error ReportStaled();

    /**
     * @notice Thrown when a report is too old
     */
    error ReportTooOld(uint64 currentTimestamp, uint64 newTimestamp);

    /**
     * @notice Thrown when the depositor is not the Lido Predeposit Guarantee
     * @param depositor Address of the depositor
     */
    error InvalidDepositor(address depositor);

    /**
     * @notice Thrown when the vault is connected to VaultHub
     */
    error VaultConnected();
}
