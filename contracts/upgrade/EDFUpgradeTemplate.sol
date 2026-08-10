// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {IAccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {EDFUpgradeConfig} from "./EDFUpgradeConfig.sol";
import {
    EDFUpgradeParameters,
    IEDFDelegationContract,
    IEDFDepositSecurityModule,
    IEDFHashConsensus
} from "./EDFUpgradeTypes.sol";

/// @title EDFUpgradeTemplate
/// @notice Validates the atomic migration from EOA oracle/DSM members to EDF delegation contracts.
contract EDFUpgradeTemplate {
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
    error InvalidMembers(address contractAddress);
    error InvalidDelegationContract(address delegationContract);

    uint256 public constant EXPECTED_FINAL_DSM_VERSION = 5;
    bytes4 public constant ERC1271_INTERFACE_ID = 0x1626ba7e;

    bytes32 internal constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    bytes32 internal constant TOP_UP_ROLE = keccak256("TOP_UP_ROLE");
    bytes32 internal constant ATTEST_MESSAGE_BASE = 0x1085395a994e25b1b3d0ea7937b7395495fb405b31c7d22dbc3976a6bd01f2bf;
    bytes32 internal constant PAUSE_MESSAGE_BASE = 0x9c4c40205558f12027f21204d6218b8006985b7a6359bcab15404bcc3e3fa122;
    bytes32 internal constant UNVET_MESSAGE_BASE = 0x2dd9727393562ed11c29080a884630e2d3a7078e71b313e713a8a1ef68948f6a;

    uint256 internal constant UPGRADE_NOT_STARTED = 0;
    // keccak256("EDFUpgradeTemplate.upgradeStartedFlag")
    bytes32 internal constant UPGRADE_STARTED_SLOT = 0x65503a7c720884b45cfb27e19fd1302ed770e34ab88ad17b0a25a7520d1816da;

    address public immutable CONFIG;
    uint256 public immutable EXPIRE_SINCE_INCLUSIVE;

    uint256 public upgradeBlockNumber = UPGRADE_NOT_STARTED;
    bool public isUpgradeFinished;

    constructor(EDFUpgradeParameters memory params, uint256 expireSinceInclusive) {
        if (params.chainId != block.chainid) revert InvalidChainId(block.chainid, params.chainId);
        if (expireSinceInclusive <= block.timestamp) revert InvalidExpiry();

        EDFUpgradeConfig config = new EDFUpgradeConfig(params);
        CONFIG = address(config);
        EXPIRE_SINCE_INCLUSIVE = expireSinceInclusive;
    }

    function startUpgrade() external {
        EDFUpgradeConfig config = EDFUpgradeConfig(CONFIG);
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
        EDFUpgradeConfig config = EDFUpgradeConfig(CONFIG);
        if (msg.sender != config.AGENT()) revert OnlyAgentCanUpgrade();
        if (isUpgradeFinished) revert UpgradeAlreadyFinished();
        if (!_isStartCalledInThisTx()) revert StartAndFinishMustBeInSameTx();

        isUpgradeFinished = true;
        _validatePostUpgradeState(config);
        emit UpgradeFinished();
    }

    function _validatePreUpgradeState(EDFUpgradeConfig config) internal virtual {
        if (block.chainid != config.CHAIN_ID()) revert InvalidChainId(block.chainid, config.CHAIN_ID());

        IOssifiableProxy locatorProxy = IOssifiableProxy(config.LOCATOR());
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.OLD_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(config.LOCATOR());
        ILidoLocator candidateLocator = ILidoLocator(config.NEW_LOCATOR_IMPLEMENTATION());
        _assertAddress("locator-dsm", locator.depositSecurityModule(), config.OLD_DEPOSIT_SECURITY_MODULE());
        _assertAddress("locator-staking-router", locator.stakingRouter(), config.STAKING_ROUTER());
        _assertAddress(
            "candidate-locator-dsm", candidateLocator.depositSecurityModule(), config.NEW_DEPOSIT_SECURITY_MODULE()
        );
        _assertAddress("candidate-staking-router", candidateLocator.stakingRouter(), config.STAKING_ROUTER());
        if (_locatorConfigHashExcludingDSM(locator) != _locatorConfigHashExcludingDSM(candidateLocator)) {
            revert InvalidMembers(config.LOCATOR());
        }

        _validateOldDSM(config);
        _validateNewDSM(config);
        _validateFactoryAndDelegationContracts(config);
        _validateOracleCommittees(config, false);

        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertUint("unvet-role-members", stakingRouter.getRoleMemberCount(STAKING_MODULE_UNVETTING_ROLE), 1);
        if (!stakingRouter.hasRole(STAKING_MODULE_UNVETTING_ROLE, config.OLD_DEPOSIT_SECURITY_MODULE())) {
            revert InvalidFlag("old-dsm-unvet-role", config.OLD_DEPOSIT_SECURITY_MODULE());
        }
        if (stakingRouter.hasRole(STAKING_MODULE_UNVETTING_ROLE, config.NEW_DEPOSIT_SECURITY_MODULE())) {
            revert InvalidFlag("new-dsm-no-unvet-role", config.NEW_DEPOSIT_SECURITY_MODULE());
        }

        if (
            IAccessControlEnumerable(config.TOP_UP_GATEWAY()).hasRole(
                TOP_UP_ROLE, config.DEPOSITOR_DELEGATION_CONTRACT()
            )
        ) {
            revert InvalidFlag("depositor-no-top-up-role", config.DEPOSITOR_DELEGATION_CONTRACT());
        }
    }

    function _validatePostUpgradeState(EDFUpgradeConfig config) internal virtual {
        IOssifiableProxy locatorProxy = IOssifiableProxy(config.LOCATOR());
        _assertAddress(
            "locator-implementation", locatorProxy.proxy__getImplementation(), config.NEW_LOCATOR_IMPLEMENTATION()
        );
        _assertAddress("locator-admin", locatorProxy.proxy__getAdmin(), config.LOCATOR_ADMIN());

        ILidoLocator locator = ILidoLocator(config.LOCATOR());
        ILidoLocator candidateLocator = ILidoLocator(config.NEW_LOCATOR_IMPLEMENTATION());
        _assertAddress("locator-dsm", locator.depositSecurityModule(), config.NEW_DEPOSIT_SECURITY_MODULE());
        if (_locatorConfigHashExcludingDSM(locator) != _locatorConfigHashExcludingDSM(candidateLocator)) {
            revert InvalidMembers(config.LOCATOR());
        }

        _validateNewDSM(config);
        _validateFactoryAndDelegationContracts(config);
        _validateOracleCommittees(config, true);

        IAccessControlEnumerable stakingRouter = IAccessControlEnumerable(config.STAKING_ROUTER());
        _assertUint("unvet-role-members", stakingRouter.getRoleMemberCount(STAKING_MODULE_UNVETTING_ROLE), 1);
        if (stakingRouter.hasRole(STAKING_MODULE_UNVETTING_ROLE, config.OLD_DEPOSIT_SECURITY_MODULE())) {
            revert InvalidFlag("old-dsm-no-unvet-role", config.OLD_DEPOSIT_SECURITY_MODULE());
        }
        if (!stakingRouter.hasRole(STAKING_MODULE_UNVETTING_ROLE, config.NEW_DEPOSIT_SECURITY_MODULE())) {
            revert InvalidFlag("new-dsm-unvet-role", config.NEW_DEPOSIT_SECURITY_MODULE());
        }

        if (
            !IAccessControlEnumerable(config.TOP_UP_GATEWAY()).hasRole(
                TOP_UP_ROLE, config.DEPOSITOR_DELEGATION_CONTRACT()
            )
        ) {
            revert InvalidFlag("depositor-top-up-role", config.DEPOSITOR_DELEGATION_CONTRACT());
        }
    }

    function _validateOldDSM(EDFUpgradeConfig config) internal view {
        IEDFDepositSecurityModule oldDSM = IEDFDepositSecurityModule(config.OLD_DEPOSIT_SECURITY_MODULE());
        _assertUint("old-dsm-version", oldDSM.VERSION(), config.OLD_DEPOSIT_SECURITY_MODULE_VERSION());
        _assertAddress("old-dsm-owner", oldDSM.getOwner(), config.AGENT());
        _assertAddress("old-dsm-staking-router", oldDSM.STAKING_ROUTER(), config.STAKING_ROUTER());
        _assertUint(
            "old-dsm-pause-validity",
            oldDSM.getPauseIntentValidityPeriodBlocks(),
            config.PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS()
        );
        _assertUint("old-dsm-max-unvetting", oldDSM.getMaxOperatorsPerUnvetting(), config.MAX_OPERATORS_PER_UNVETTING());
        _assertUint("old-dsm-quorum", oldDSM.getGuardianQuorum(), config.GUARDIAN_QUORUM());
        if (oldDSM.isDepositsPaused()) revert InvalidFlag("old-dsm-paused", address(oldDSM));

        address[] memory guardians = oldDSM.getGuardians();
        uint256 guardiansCount = config.guardiansCount();
        if (guardians.length != guardiansCount) revert InvalidMembers(address(oldDSM));
        for (uint256 i = 0; i < guardiansCount; ++i) {
            (address oldGuardian,) = config.guardianMapping(i);
            if (!oldDSM.isGuardian(oldGuardian)) revert InvalidMembers(address(oldDSM));
        }
    }

    function _validateNewDSM(EDFUpgradeConfig config) internal view {
        IEDFDepositSecurityModule newDSM = IEDFDepositSecurityModule(config.NEW_DEPOSIT_SECURITY_MODULE());
        _assertUint("new-dsm-version", newDSM.VERSION(), EXPECTED_FINAL_DSM_VERSION);
        _assertAddress("new-dsm-owner", newDSM.getOwner(), config.AGENT());
        _assertAddress("new-dsm-staking-router", newDSM.STAKING_ROUTER(), config.STAKING_ROUTER());
        _assertAddress(
            "new-dsm-deposit-contract",
            newDSM.DEPOSIT_CONTRACT(),
            IEDFDepositSecurityModule(config.OLD_DEPOSIT_SECURITY_MODULE()).DEPOSIT_CONTRACT()
        );
        _assertUint(
            "new-dsm-pause-validity",
            newDSM.getPauseIntentValidityPeriodBlocks(),
            config.PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS()
        );
        _assertUint("new-dsm-max-unvetting", newDSM.getMaxOperatorsPerUnvetting(), config.MAX_OPERATORS_PER_UNVETTING());
        _assertUint("new-dsm-quorum", newDSM.getGuardianQuorum(), config.GUARDIAN_QUORUM());
        if (newDSM.isDepositsPaused()) revert InvalidFlag("new-dsm-paused", address(newDSM));

        _assertUint(
            "new-dsm-attest-prefix",
            uint256(newDSM.ATTEST_MESSAGE_PREFIX()),
            uint256(keccak256(abi.encodePacked(ATTEST_MESSAGE_BASE, config.CHAIN_ID(), address(newDSM))))
        );
        _assertUint(
            "new-dsm-pause-prefix",
            uint256(newDSM.PAUSE_MESSAGE_PREFIX()),
            uint256(keccak256(abi.encodePacked(PAUSE_MESSAGE_BASE, config.CHAIN_ID(), address(newDSM))))
        );
        _assertUint(
            "new-dsm-unvet-prefix",
            uint256(newDSM.UNVET_MESSAGE_PREFIX()),
            uint256(keccak256(abi.encodePacked(UNVET_MESSAGE_BASE, config.CHAIN_ID(), address(newDSM))))
        );

        address[] memory guardians = newDSM.getGuardians();
        uint256 guardiansCount = config.guardiansCount();
        if (guardians.length != guardiansCount) revert InvalidMembers(address(newDSM));
        for (uint256 i = 0; i < guardiansCount; ++i) {
            address guardian = config.guardian(i);
            if (!newDSM.isGuardian(guardian)) revert InvalidMembers(address(newDSM));
        }
    }

    function _validateFactoryAndDelegationContracts(EDFUpgradeConfig config) internal view {
        address factory = config.DELEGATION_FACTORY();
        if (factory.codehash != config.DELEGATION_FACTORY_RUNTIME_CODE_HASH()) {
            revert InvalidDelegationContract(factory);
        }

        uint256 contractsCount = config.delegationContractsCount();
        for (uint256 i = 0; i < contractsCount; ++i) {
            (address contractAddress, address owner, address delegate, uint256 cooldown, bytes32 runtimeCodeHash) =
                config.delegationContract(i);
            if (contractAddress.codehash != runtimeCodeHash) revert InvalidDelegationContract(contractAddress);
            IEDFDelegationContract delegation = IEDFDelegationContract(contractAddress);
            if (
                delegation.owner() != owner || delegation.getDelegate() != delegate
                    || delegation.getCooldown() != cooldown || delegation.isTerminated()
                    || !delegation.supportsInterface(ERC1271_INTERFACE_ID)
            ) {
                revert InvalidDelegationContract(contractAddress);
            }
        }
    }

    function _validateOracleCommittees(EDFUpgradeConfig config, bool finalState) internal view {
        uint256 committeesCount = config.oracleCommitteesCount();
        for (uint256 i = 0; i < committeesCount; ++i) {
            (address consensusAddress, uint256 quorum) = config.oracleCommittee(i);
            IEDFHashConsensus consensus = IEDFHashConsensus(consensusAddress);
            (address[] memory members,) = consensus.getMembers();
            uint256 mappingsCount = config.oracleCommitteeMappingsCount(i);
            if (members.length != mappingsCount || consensus.getQuorum() != quorum) {
                revert InvalidMembers(consensusAddress);
            }

            for (uint256 j = 0; j < mappingsCount; ++j) {
                (address oldMember, address newMember) = config.oracleCommitteeMapping(i, j);
                address expectedMember = finalState ? newMember : oldMember;
                address unexpectedMember = finalState ? oldMember : newMember;
                if (!consensus.getIsMember(expectedMember) || consensus.getIsMember(unexpectedMember)) {
                    revert InvalidMembers(consensusAddress);
                }
            }
        }
    }

    function _locatorConfigHashExcludingDSM(ILidoLocator locator) internal view returns (bytes32 hash) {
        hash = _hashAddress(hash, locator.accountingOracle());
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
        hash = _hashAddress(hash, locator.validatorExitDelayVerifier());
        hash = _hashAddress(hash, locator.triggerableWithdrawalsGateway());
        hash = _hashAddress(hash, locator.consolidationGateway());
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
