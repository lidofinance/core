// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {ICircuitBreaker} from "contracts/common/interfaces/ICircuitBreaker.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {IUpgradeTemplate} from "./interfaces/IUpgradeTemplate.sol";
import {UpgradeConfig} from "./UpgradeConfig.sol";
import {UpgradeParameters, IGloasForkAware, IWithdrawalsManagerProxy} from "./UpgradeTypes.sol";

/// @title UpgradeTemplate
/// @notice Pre/post checks wrapping the Gloas upgrade vote.
/// @dev `startUpgrade` and `finishUpgrade` must run in the same transaction, so the whole vote
///      reverts if the observed state does not match what was deployed.
contract UpgradeTemplate is IUpgradeTemplate {
    event UpgradeStarted();
    event UpgradeFinished();

    error OnlyAgentCanUpgrade();
    error StartAndFinishMustBeInSameTx();
    error StartAlreadyCalledInThisTx();
    error Expired();
    error InvalidExpiry();
    error InvalidChainId(uint256 actual, uint256 expected);
    error UpgradeAlreadyStarted();
    error UpgradeAlreadyFinished();
    error InvalidAddress(bytes32 field, address actual, address expected);
    error InvalidUint(bytes32 field, uint256 actual, uint256 expected);
    error InvalidFlag(bytes32 field, address subject);
    error LocatorChangedBeyondGloas();
    error GloasSlotMismatch(address subject, uint64 actual, uint64 expected);

    bytes32 internal constant DEFAULT_ADMIN_ROLE = 0x00;
    bytes32 internal constant PAUSE_ROLE = keccak256("PAUSE_ROLE");
    bytes32 internal constant RESUME_ROLE = keccak256("RESUME_ROLE");
    bytes32 internal constant ADD_CONSOLIDATION_REQUEST_ROLE = keccak256("ADD_CONSOLIDATION_REQUEST_ROLE");
    bytes32 internal constant REPORT_VALIDATOR_EXITING_STATUS_ROLE =
        keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");

    uint256 internal constant UPGRADE_NOT_STARTED = 0;
    // keccak256("UpgradeTemplate.upgradeStartedFlag")
    bytes32 internal constant UPGRADE_STARTED_SLOT = 0x35b46117eef044799338cc40f60a0c4c38c26772e3f81f535801c8d814ecc33d;

    address public immutable override CONFIG;
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public override isUpgradeFinished;

    constructor(UpgradeParameters memory params, uint256 expireSinceInclusive) {
        if (params.chainId != block.chainid) revert InvalidChainId(block.chainid, params.chainId);
        if (expireSinceInclusive <= block.timestamp) revert InvalidExpiry();

        CONFIG = address(new UpgradeConfig(params));
        EXPIRE_SINCE_INCLUSIVE = expireSinceInclusive;
    }

    function startUpgrade() external {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (block.timestamp >= EXPIRE_SINCE_INCLUSIVE) revert Expired();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (_isStartCalledInThisTx()) revert StartAlreadyCalledInThisTx();
        if (upgradeBlockNumber != UPGRADE_NOT_STARTED) revert UpgradeAlreadyStarted();

        assembly {
            tstore(UPGRADE_STARTED_SLOT, 1)
        }
        upgradeBlockNumber = block.number;

        _validatePreUpgradeState(config);
        emit UpgradeStarted();
    }

    function finishUpgrade() external {
        UpgradeConfig config = UpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;
        _validatePostUpgradeState(config);
        emit UpgradeFinished();
    }

    function _validatePreUpgradeState(UpgradeConfig config) internal virtual {
        if (block.chainid != config.CHAIN_ID()) revert InvalidChainId(block.chainid, config.CHAIN_ID());

        IOssifiableProxy locatorProxy = IOssifiableProxy(config.LOCATOR());
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.OLD_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(config.LOCATOR());
        _assertAddress("locator-verifier", locator.validatorExitDelayVerifier(), config.OLD_VALIDATOR_EXIT_DELAY_VERIFIER());
        _assertAddress("locator-consolidation-gateway", locator.consolidationGateway(), config.OLD_CONSOLIDATION_GATEWAY());
        _assertUnchangedLocatorMembers(config, locator);

        // The candidate implementation must differ from the live one in exactly the two Gloas slots.
        ILidoLocator candidate = ILidoLocator(config.NEW_LOCATOR_IMPLEMENTATION());
        _assertAddress(
            "candidate-verifier", candidate.validatorExitDelayVerifier(), config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER()
        );
        _assertAddress(
            "candidate-consolidation-gateway", candidate.consolidationGateway(), config.NEW_CONSOLIDATION_GATEWAY()
        );
        if (_locatorHashExcludingGloas(locator) != _locatorHashExcludingGloas(candidate)) {
            revert LocatorChangedBeyondGloas();
        }

        _assertNotYetUpgraded("pdg", IOssifiableProxy(config.PREDEPOSIT_GUARANTEE()).proxy__getImplementation(), config.NEW_PREDEPOSIT_GUARANTEE_IMPL());
        _assertNotYetUpgraded("top-up-gateway", IOssifiableProxy(config.TOP_UP_GATEWAY()).proxy__getImplementation(), config.NEW_TOP_UP_GATEWAY_IMPL());
        _assertNotYetUpgraded("consolidation-bus", IOssifiableProxy(config.CONSOLIDATION_BUS()).proxy__getImplementation(), config.NEW_CONSOLIDATION_BUS_IMPL());
        _assertNotYetUpgraded("withdrawal-vault", IWithdrawalsManagerProxy(config.WITHDRAWAL_VAULT()).implementation(), config.NEW_WITHDRAWAL_VAULT_IMPL());

        // Every new artifact must carry the same fork switch, otherwise the protocol would
        // straddle the fork with half of the proofs on the pre-Gloas layout.
        _assertConsistentGloasSlot(config);

        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        if (!stakingRouter.hasRole(REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.OLD_VALIDATOR_EXIT_DELAY_VERIFIER())) {
            revert InvalidFlag("old-verifier-report-role", config.OLD_VALIDATOR_EXIT_DELAY_VERIFIER());
        }
        if (stakingRouter.hasRole(REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER())) {
            revert InvalidFlag("new-verifier-no-report-role", config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER());
        }

        // The new gateway is deployed with the Agent as its admin and no other role granted yet.
        IAccessControlEnumerable gateway = IAccessControlEnumerable(config.NEW_CONSOLIDATION_GATEWAY());
        if (!gateway.hasRole(DEFAULT_ADMIN_ROLE, config.AGENT())) {
            revert InvalidFlag("new-gateway-admin", config.AGENT());
        }
        _assertUint("new-gateway-pause-members", gateway.getRoleMemberCount(PAUSE_ROLE), 0);
        _assertUint("new-gateway-resume-members", gateway.getRoleMemberCount(RESUME_ROLE), 0);
        _assertUint("new-gateway-add-request-members", gateway.getRoleMemberCount(ADD_CONSOLIDATION_REQUEST_ROLE), 0);

        _assertAddress(
            "new-gateway-pauser", ICircuitBreaker(config.CIRCUIT_BREAKER()).getPauser(config.NEW_CONSOLIDATION_GATEWAY()), address(0)
        );
    }

    function _validatePostUpgradeState(UpgradeConfig config) internal virtual {
        IOssifiableProxy locatorProxy = IOssifiableProxy(config.LOCATOR());
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.NEW_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(config.LOCATOR());
        _assertAddress("locator-verifier", locator.validatorExitDelayVerifier(), config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER());
        _assertAddress("locator-consolidation-gateway", locator.consolidationGateway(), config.NEW_CONSOLIDATION_GATEWAY());
        _assertUnchangedLocatorMembers(config, locator);

        _assertAddress("pdg-implementation", IOssifiableProxy(config.PREDEPOSIT_GUARANTEE()).proxy__getImplementation(), config.NEW_PREDEPOSIT_GUARANTEE_IMPL());
        _assertAddress("top-up-gateway-implementation", IOssifiableProxy(config.TOP_UP_GATEWAY()).proxy__getImplementation(), config.NEW_TOP_UP_GATEWAY_IMPL());
        _assertAddress("consolidation-bus-implementation", IOssifiableProxy(config.CONSOLIDATION_BUS()).proxy__getImplementation(), config.NEW_CONSOLIDATION_BUS_IMPL());
        _assertAddress("withdrawal-vault-implementation", IWithdrawalsManagerProxy(config.WITHDRAWAL_VAULT()).implementation(), config.NEW_WITHDRAWAL_VAULT_IMPL());

        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertUint("report-role-members", stakingRouter.getRoleMemberCount(REPORT_VALIDATOR_EXITING_STATUS_ROLE), 1);
        if (stakingRouter.hasRole(REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.OLD_VALIDATOR_EXIT_DELAY_VERIFIER())) {
            revert InvalidFlag("old-verifier-no-report-role", config.OLD_VALIDATOR_EXIT_DELAY_VERIFIER());
        }
        if (!stakingRouter.hasRole(REPORT_VALIDATOR_EXITING_STATUS_ROLE, config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER())) {
            revert InvalidFlag("new-verifier-report-role", config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER());
        }

        IAccessControlEnumerable gateway = IAccessControlEnumerable(config.NEW_CONSOLIDATION_GATEWAY());
        if (!gateway.hasRole(PAUSE_ROLE, config.CIRCUIT_BREAKER())) {
            revert InvalidFlag("new-gateway-pause-cb", config.CIRCUIT_BREAKER());
        }
        if (!gateway.hasRole(PAUSE_ROLE, config.RESEAL_MANAGER())) {
            revert InvalidFlag("new-gateway-pause-reseal", config.RESEAL_MANAGER());
        }
        if (!gateway.hasRole(RESUME_ROLE, config.RESEAL_MANAGER())) {
            revert InvalidFlag("new-gateway-resume-reseal", config.RESEAL_MANAGER());
        }
        if (!gateway.hasRole(ADD_CONSOLIDATION_REQUEST_ROLE, config.CONSOLIDATION_BUS())) {
            revert InvalidFlag("new-gateway-add-request-bus", config.CONSOLIDATION_BUS());
        }
        if (!gateway.hasRole(DEFAULT_ADMIN_ROLE, config.AGENT())) {
            revert InvalidFlag("new-gateway-admin", config.AGENT());
        }

        _assertAddress(
            "new-gateway-pauser",
            ICircuitBreaker(config.CIRCUIT_BREAKER()).getPauser(config.NEW_CONSOLIDATION_GATEWAY()),
            config.CIRCUIT_BREAKER_COMMITTEE()
        );
    }

    /// @dev Addresses the vote must leave untouched; checked identically before and after.
    function _assertUnchangedLocatorMembers(UpgradeConfig config, ILidoLocator locator) private view {
        _assertAddress("locator-staking-router", locator.stakingRouter(), config.STAKING_ROUTER());
        _assertAddress("locator-pdg", locator.predepositGuarantee(), config.PREDEPOSIT_GUARANTEE());
        _assertAddress("locator-top-up-gateway", locator.topUpGateway(), config.TOP_UP_GATEWAY());
        _assertAddress("locator-withdrawal-vault", locator.withdrawalVault(), config.WITHDRAWAL_VAULT());
    }

    function _assertConsistentGloasSlot(UpgradeConfig config) private view {
        uint64 expected = IGloasForkAware(config.NEW_VALIDATOR_EXIT_DELAY_VERIFIER()).GLOAS_SLOT();
        _assertGloasSlot(config.NEW_CONSOLIDATION_GATEWAY(), expected);
        _assertGloasSlot(config.NEW_PREDEPOSIT_GUARANTEE_IMPL(), expected);
        _assertGloasSlot(config.NEW_TOP_UP_GATEWAY_IMPL(), expected);
    }

    function _assertGloasSlot(address subject, uint64 expected) private view {
        uint64 actual = IGloasForkAware(subject).GLOAS_SLOT();
        if (actual != expected) revert GloasSlotMismatch(subject, actual, expected);
    }

    function _assertNotYetUpgraded(bytes32 field, address current, address newImpl) private pure {
        if (current == newImpl) revert InvalidFlag(field, current);
    }

    /// @dev Every locator member except the two the Gloas upgrade replaces.
    function _locatorHashExcludingGloas(ILidoLocator locator) private view returns (bytes32 hash) {
        hash = _hashAddress(hash, locator.accountingOracle());
        hash = _hashAddress(hash, locator.depositSecurityModule());
        hash = _hashAddress(hash, locator.elRewardsVault());
        hash = _hashAddress(hash, locator.lido());
        hash = _hashAddress(hash, locator.oracleReportSanityChecker());
        hash = _hashAddress(hash, locator.burner());
        hash = _hashAddress(hash, locator.stakingRouter());
        hash = _hashAddress(hash, locator.treasury());
        hash = _hashAddress(hash, locator.validatorsExitBusOracle());
        hash = _hashAddress(hash, locator.withdrawalQueue());
        hash = _hashAddress(hash, locator.withdrawalVault());
        hash = _hashAddress(hash, locator.postTokenRebaseReceiver());
        hash = _hashAddress(hash, locator.oracleDaemonConfig());
        hash = _hashAddress(hash, locator.accounting());
        hash = _hashAddress(hash, locator.predepositGuarantee());
        hash = _hashAddress(hash, locator.wstETH());
        hash = _hashAddress(hash, locator.vaultHub());
        hash = _hashAddress(hash, locator.vaultFactory());
        hash = _hashAddress(hash, locator.lazyOracle());
        hash = _hashAddress(hash, locator.operatorGrid());
        hash = _hashAddress(hash, locator.topUpGateway());
        hash = _hashAddress(hash, locator.triggerableWithdrawalsGateway());
    }

    function _hashAddress(bytes32 previousHash, address value) private pure returns (bytes32) {
        return keccak256(abi.encode(previousHash, value));
    }

    function _assertAddress(bytes32 field, address actual, address expected) private pure {
        if (actual != expected) revert InvalidAddress(field, actual, expected);
    }

    function _assertUint(bytes32 field, uint256 actual, uint256 expected) private pure {
        if (actual != expected) revert InvalidUint(field, actual, expected);
    }

    function _isStartCalledInThisTx() internal view returns (bool isStartCalledInThisTx) {
        assembly {
            isStartCalledInThisTx := tload(UPGRADE_STARTED_SLOT)
        }
    }
}
