// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
pragma solidity 0.8.25;

import {OwnableUpgradeable} from "contracts/openzeppelin/5.2/upgradeable/access/OwnableUpgradeable.sol";
import {ERC165} from "@openzeppelin/contracts-v5.2/utils/introspection/ERC165.sol";
import {IERC1271} from "@openzeppelin/contracts-v5.2/interfaces/IERC1271.sol";

import {VaultHub} from "./VaultHub.sol";
import {SignatureUtils} from "contracts/common/lib/SignatureUtils.sol";

import {IDepositContract} from "../interfaces/IDepositContract.sol";
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
 *   - `requestValidatorExit()`
 *   - `rebalance()`
 *   - `pauseBeaconChainDeposits()`
 *   - `resumeBeaconChainDeposits()`
 * - Operator:
 *   - `depositToBeaconChain()`
 * - VaultHub:
 *   - `lock()`
 *   - `report()`
 *   - `rebalance()`
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
contract StakingVault is IStakingVault, OwnableUpgradeable {
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
        address depositGuardian;
        bool beaconChainDepositsPaused;
    }

    /**
     * @notice Version of the contract on the implementation
     *         The implementation is petrified to this version
     */
    uint64 private constant _VERSION = 1;

    bytes32 public constant DEPOSIT_GUARDIAN_MESSAGE_PREFIX = keccak256("StakingVault.DepositGuardianMessagePrefix");

    /**
     * @notice Address of `VaultHub`
     *         Set immutably in the constructor to avoid storage costs
     */
    VaultHub private immutable VAULT_HUB;

    /**
     * @notice Address of `BeaconChainDepositContract`
     *         Set immutably in the constructor to avoid storage costs
     */
    IDepositContract private immutable BEACON_CHAIN_DEPOSIT_CONTRACT;

    /**
     * @notice Storage offset slot for ERC-7201 namespace
     *         The storage namespace is used to prevent upgrade collisions
     *         `keccak256(abi.encode(uint256(keccak256("Lido.Vaults.StakingVault")) - 1)) & ~bytes32(uint256(0xff))`
     */
    bytes32 private constant ERC721_STORAGE_LOCATION =
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
        BEACON_CHAIN_DEPOSIT_CONTRACT = IDepositContract(_beaconChainDepositContract);

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
        _getStorage().depositGuardian = _owner;
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
     * @notice Returns the address of `BeaconChainDepositContract`
     * @return Address of `BeaconChainDepositContract`
     */
    function depositContract() external view returns (address) {
        return address(BEACON_CHAIN_DEPOSIT_CONTRACT);
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
     * @notice Returns whether deposits are paused by the vault owner
     * @return True if deposits are paused
     */
    function beaconChainDepositsPaused() external view returns (bool) {
        return _getStorage().beaconChainDepositsPaused;
    }

    /**
     * @notice Returns whether `StakingVault` is balanced, i.e. its valuation is greater than the locked amount
     * @return True if `StakingVault` is balanced
     * @dev Not to be confused with the ether balance of the contract (`address(this).balance`).
     *      Semantically, this state has nothing to do with the actual balance of the contract,
     *      althogh, of course, the balance of the contract is accounted for in its valuation.
     *      The `isBalanced()` state indicates whether `StakingVault` is in a good shape
     *      in terms of the balance of its valuation against the locked amount.
     */
    function isBalanced() public view returns (bool) {
        return valuation() >= _getStorage().locked;
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
     * @notice Returns the 0x01-type withdrawal credentials for the validators deposited from this `StakingVault`
     *         All CL rewards are sent to this contract. Only 0x01-type withdrawal credentials are supported for now.
     * @return Withdrawal credentials as bytes32
     */
    function withdrawalCredentials() public view returns (bytes32) {
        return bytes32((0x01 << 248) + uint160(address(this)));
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
     * @dev Includes the `isBalanced()` check to ensure `StakingVault` remains balanced after the withdrawal,
     *      to safeguard against possible reentrancy attacks.
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
        if (!isBalanced()) revert Unbalanced();

        emit Withdrawn(msg.sender, _recipient, _ether);
    }

    /**
     * @notice Performs a deposit to the beacon chain deposit contract
     * @param _deposits Array of deposit structs
     * @dev Includes a check to ensure StakingVault is balanced before making deposits
     */
    function depositToBeaconChain(
        Deposit[] calldata _deposits,
        bytes32 _expectedGlobalDepositRoot,
        GuardianSignature calldata _signature
    ) external {
        if (_deposits.length == 0) revert ZeroArgument("_deposits");

        bytes32 currentGlobalDepositRoot = BEACON_CHAIN_DEPOSIT_CONTRACT.get_deposit_root();
        if (_expectedGlobalDepositRoot != currentGlobalDepositRoot)
            revert GlobalDepositRootMismatch(_expectedGlobalDepositRoot, currentGlobalDepositRoot);

        ERC7201Storage storage $ = _getStorage();
        if (msg.sender != $.nodeOperator) revert NotAuthorized("depositToBeaconChain", msg.sender);
        if ($.beaconChainDepositsPaused) revert BeaconChainDepositsArePaused();
        if (!isBalanced()) revert Unbalanced();

        uint256 totalAmount = 0;
        uint256 numberOfDeposits = _deposits.length;
        bytes memory concatenatedDepositDataRoots;

        for (uint256 i = 0; i < numberOfDeposits; i++) {
            Deposit calldata deposit = _deposits[i];
            BEACON_CHAIN_DEPOSIT_CONTRACT.deposit{value: deposit.amount}(
                deposit.pubkey,
                bytes.concat(withdrawalCredentials()),
                deposit.signature,
                deposit.depositDataRoot
            );

            totalAmount += deposit.amount;
            concatenatedDepositDataRoots = abi.encodePacked(concatenatedDepositDataRoots, deposit.depositDataRoot);
        }

        if (
            !SignatureUtils.isValidSignature(
                $.depositGuardian,
                keccak256(
                    abi.encodePacked(
                        DEPOSIT_GUARDIAN_MESSAGE_PREFIX,
                        _expectedGlobalDepositRoot,
                        keccak256(concatenatedDepositDataRoots)
                    )
                ),
                _signature.v,
                _signature.r,
                _signature.s
            )
        ) revert DepositGuardianSignatureInvalid();

        emit DepositedToBeaconChain(msg.sender, numberOfDeposits, totalAmount);
    }

    /**
     * @notice Requests validator exit from the beacon chain
     * @param _pubkeys Concatenated validator public keys
     * @dev Signals the node operator to eject the specified validators from the beacon chain
     */
    function requestValidatorExit(bytes calldata _pubkeys) external onlyOwner {
        emit ValidatorsExitRequest(msg.sender, _pubkeys);
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

        if (owner() == msg.sender || (!isBalanced() && msg.sender == address(VAULT_HUB))) {
            ERC7201Storage storage $ = _getStorage();
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
     * @notice Sets the deposit guardian
     * @param _depositGuardian The address of the deposit guardian
     * @dev If the deposit guardian is set to a contract, it must implement EIP-1271,
     *      even though the function does not check for the interface requirement.
     */
    function setDepositGuardian(address _depositGuardian) external onlyOwner {
        if (_depositGuardian == address(0)) revert ZeroArgument("_depositGuardian");

        // perhaps, we don't need this check because there can be edge cases, e.g.
        // account-abstracted addresses or CREATE2-deployed contracts.
        if (
            SignatureUtils._hasCode(_depositGuardian) &&
            !ERC165(_depositGuardian).supportsInterface(type(IERC1271).interfaceId)
        ) revert DepositGuardianContractDoesNotSupportEIP1271();

        ERC7201Storage storage $ = _getStorage();
        address oldDepositGuardian = $.depositGuardian;

        $.depositGuardian = _depositGuardian;

        emit DepositGuardianSet(oldDepositGuardian, _depositGuardian);
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
     *
     */
    function computeDepositDataRoot(
        bytes calldata _pubkey,
        bytes calldata _withdrawalCredentials,
        bytes calldata _signature,
        uint256 _amount
    ) external view returns (bytes32) {
        // Step 1. Convert the deposit amount in wei to gwei in 64-bit bytes
        bytes memory amountBE64 = abi.encodePacked(uint64(_amount / 1 gwei));

        // Step 2. Convert the amount to little-endian format by flipping the bytes 🧠
        bytes memory amountLE64 = new bytes(8);
        amountLE64[0] = amountBE64[7];
        amountLE64[1] = amountBE64[6];
        amountLE64[2] = amountBE64[5];
        amountLE64[3] = amountBE64[4];
        amountLE64[4] = amountBE64[3];
        amountLE64[5] = amountBE64[2];
        amountLE64[6] = amountBE64[1];
        amountLE64[7] = amountBE64[0];

        // Step 3. Compute the root of the pubkey
        bytes32 pubkeyRoot = sha256(abi.encodePacked(_pubkey, bytes16(0)));

        // Step 4. Compute the root of the signature
        bytes32 sigSlice1Root = sha256(abi.encodePacked(_signature[0:64]));
        bytes32 sigSlice2Root = sha256(abi.encodePacked(_signature[64:], bytes32(0)));
        bytes32 signatureRoot = sha256(abi.encodePacked(sigSlice1Root, sigSlice2Root));

        // Step 5. Compute the root-toot-toorootoo of the deposit data
        bytes32 depositDataRoot = sha256(
            abi.encodePacked(
                sha256(abi.encodePacked(pubkeyRoot, _withdrawalCredentials)),
                sha256(abi.encodePacked(amountLE64, bytes24(0), signatureRoot))
            )
        );

        return depositDataRoot;
    }

    /**
     * @notice Pauses deposits to beacon chain
     * @dev Can only be called by the vault owner
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
     * @dev Can only be called by the vault owner
     */
    function resumeBeaconChainDeposits() external onlyOwner {
        ERC7201Storage storage $ = _getStorage();
        if (!$.beaconChainDepositsPaused) {
            revert BeaconChainDepositsPauseExpected();
        }

        $.beaconChainDepositsPaused = false;

        emit BeaconChainDepositsResumed();
    }

    function _getStorage() private pure returns (ERC7201Storage storage $) {
        assembly {
            $.slot := ERC721_STORAGE_LOCATION
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
     * @notice Emitted when ether is deposited to `DepositContract`
     * @param sender Address that initiated the deposit
     * @param deposits Number of validator deposits made
     */
    event DepositedToBeaconChain(address indexed sender, uint256 deposits, uint256 totalAmount);

    /**
     * @notice Emitted when a validator exit request is made
     * @dev Signals `nodeOperator` to exit the validator
     * @param sender Address that requested the validator exit
     * @param pubkey Public key of the validator requested to exit
     */
    event ValidatorsExitRequest(address indexed sender, bytes pubkey);

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
     * @notice Emitted when the deposit guardian is set
     * @param oldDepositGuardian The address of the old deposit guardian
     * @param newDepositGuardian The address of the new deposit guardian
     */
    event DepositGuardianSet(address oldDepositGuardian, address newDepositGuardian);

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
     * @notice Thrown when the global deposit root does not match the expected global deposit root
     */
    error GlobalDepositRootMismatch(bytes32 expected, bytes32 actual);

    /**
     * @notice Thrown when the guardian signature is invalid
     */
    error DepositGuardianSignatureInvalid();

    /**
     * @notice Thrown when the deposit guardian is not an EIP-1271 contract
     */
    error DepositGuardianContractDoesNotSupportEIP1271();

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
