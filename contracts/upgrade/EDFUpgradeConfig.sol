// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

import {EDFDelegationContract, EDFMemberMapping, EDFOracleCommittee, EDFUpgradeParameters} from "./EDFUpgradeTypes.sol";

contract EDFUpgradeConfig {
    error ZeroAddress(string field);
    error InvalidChainId(uint256 chainId);
    error InvalidFactoryCodeHash();
    error InvalidGuardianQuorum(uint256 quorum, uint256 guardiansCount);
    error InvalidCommitteeCount(uint256 count);
    error InvalidCommittee(uint256 index);
    error InvalidDelegationContract(uint256 index);
    error DuplicateAddress(address value);
    error UnknownDelegationContract(address value);

    uint256 public constant EXPECTED_COMMITTEES_COUNT = 4;

    uint256 public immutable CHAIN_ID;
    address public immutable LOCATOR;
    address public immutable OLD_LOCATOR_IMPLEMENTATION;
    address public immutable NEW_LOCATOR_IMPLEMENTATION;
    address public immutable LOCATOR_ADMIN;
    address public immutable AGENT;
    address public immutable VOTING;
    address public immutable DUAL_GOVERNANCE;
    address public immutable STAKING_ROUTER;
    address public immutable OLD_DEPOSIT_SECURITY_MODULE;
    address public immutable NEW_DEPOSIT_SECURITY_MODULE;
    uint256 public immutable OLD_DEPOSIT_SECURITY_MODULE_VERSION;
    address public immutable DELEGATION_FACTORY;
    bytes32 public immutable DELEGATION_FACTORY_RUNTIME_CODE_HASH;
    uint256 public immutable PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS;
    uint256 public immutable MAX_OPERATORS_PER_UNVETTING;
    uint256 public immutable GUARDIAN_QUORUM;
    address public immutable TOP_UP_GATEWAY;
    address public immutable DEPOSITOR_DELEGATION_CONTRACT;

    EDFMemberMapping[] private _guardianMappings;
    EDFOracleCommittee[] private _oracleCommittees;
    EDFDelegationContract[] private _delegationContracts;

    constructor(EDFUpgradeParameters memory params) {
        if (params.chainId == 0) revert InvalidChainId(params.chainId);
        CHAIN_ID = params.chainId;
        LOCATOR = _nonZero(params.locator, "locator");
        OLD_LOCATOR_IMPLEMENTATION = _nonZero(params.oldLocatorImplementation, "oldLocatorImplementation");
        NEW_LOCATOR_IMPLEMENTATION = _nonZero(params.newLocatorImplementation, "newLocatorImplementation");
        LOCATOR_ADMIN = _nonZero(params.locatorAdmin, "locatorAdmin");
        AGENT = _nonZero(params.agent, "agent");
        VOTING = _nonZero(params.voting, "voting");
        DUAL_GOVERNANCE = _nonZero(params.dualGovernance, "dualGovernance");
        STAKING_ROUTER = _nonZero(params.stakingRouter, "stakingRouter");
        OLD_DEPOSIT_SECURITY_MODULE = _nonZero(params.oldDepositSecurityModule, "oldDepositSecurityModule");
        NEW_DEPOSIT_SECURITY_MODULE = _nonZero(params.newDepositSecurityModule, "newDepositSecurityModule");
        if (params.oldDepositSecurityModule == params.newDepositSecurityModule) {
            revert DuplicateAddress(params.oldDepositSecurityModule);
        }
        OLD_DEPOSIT_SECURITY_MODULE_VERSION = params.oldDepositSecurityModuleVersion;
        DELEGATION_FACTORY = _nonZero(params.delegationFactory, "delegationFactory");
        if (params.delegationFactoryRuntimeCodeHash == bytes32(0)) revert InvalidFactoryCodeHash();
        DELEGATION_FACTORY_RUNTIME_CODE_HASH = params.delegationFactoryRuntimeCodeHash;
        PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS = params.pauseIntentValidityPeriodBlocks;
        MAX_OPERATORS_PER_UNVETTING = params.maxOperatorsPerUnvetting;
        GUARDIAN_QUORUM = params.guardianQuorum;
        TOP_UP_GATEWAY = _nonZero(params.topUpGateway, "topUpGateway");
        DEPOSITOR_DELEGATION_CONTRACT = _nonZero(params.depositorDelegationContract, "depositorDelegationContract");

        _storeDelegationContracts(params.delegationContracts);
        _storeGuardianMappings(params.guardianMappings, params.guardianQuorum);
        _storeOracleCommittees(params.oracleCommittees);

        if (!isConfiguredDelegationContract(params.depositorDelegationContract)) {
            revert UnknownDelegationContract(params.depositorDelegationContract);
        }
    }

    function guardiansCount() external view returns (uint256) {
        return _guardianMappings.length;
    }

    function guardian(uint256 index) external view returns (address) {
        return _guardianMappings[index].newMember;
    }

    function guardianMapping(uint256 index) external view returns (address oldGuardian, address newGuardian) {
        EDFMemberMapping storage memberMapping = _guardianMappings[index];
        return (memberMapping.oldMember, memberMapping.newMember);
    }

    function oracleCommitteesCount() external view returns (uint256) {
        return _oracleCommittees.length;
    }

    function oracleCommittee(uint256 index) external view returns (address consensusContract, uint256 quorum) {
        EDFOracleCommittee storage committee = _oracleCommittees[index];
        return (committee.consensusContract, committee.quorum);
    }

    function oracleCommitteeMappingsCount(uint256 committeeIndex) external view returns (uint256) {
        return _oracleCommittees[committeeIndex].memberMappings.length;
    }

    function oracleCommitteeMapping(uint256 committeeIndex, uint256 mappingIndex)
        external
        view
        returns (address oldMember, address newMember)
    {
        EDFMemberMapping storage memberMapping = _oracleCommittees[committeeIndex].memberMappings[mappingIndex];
        return (memberMapping.oldMember, memberMapping.newMember);
    }

    function oracleMappingsCount() external view returns (uint256 count) {
        for (uint256 i = 0; i < _oracleCommittees.length; ++i) {
            count += _oracleCommittees[i].memberMappings.length;
        }
    }

    function delegationContractsCount() external view returns (uint256) {
        return _delegationContracts.length;
    }

    function delegationContract(uint256 index)
        external
        view
        returns (address contractAddress, address owner, address delegate, uint256 cooldown, bytes32 runtimeCodeHash)
    {
        EDFDelegationContract storage delegation = _delegationContracts[index];
        return (
            delegation.delegationContract,
            delegation.owner,
            delegation.delegate,
            delegation.cooldown,
            delegation.runtimeCodeHash
        );
    }

    function isConfiguredDelegationContract(address candidate) public view returns (bool) {
        for (uint256 i = 0; i < _delegationContracts.length; ++i) {
            if (_delegationContracts[i].delegationContract == candidate) return true;
        }
        return false;
    }

    function _storeDelegationContracts(EDFDelegationContract[] memory delegationContracts) private {
        if (delegationContracts.length == 0) revert InvalidDelegationContract(0);
        for (uint256 i = 0; i < delegationContracts.length; ++i) {
            EDFDelegationContract memory delegation = delegationContracts[i];
            if (
                delegation.delegationContract == address(0) || delegation.owner == address(0)
                    || delegation.delegate == address(0) || delegation.owner == delegation.delegate
                    || delegation.runtimeCodeHash == bytes32(0)
            ) {
                revert InvalidDelegationContract(i);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (_delegationContracts[j].delegationContract == delegation.delegationContract) {
                    revert DuplicateAddress(delegation.delegationContract);
                }
            }
            _delegationContracts.push(delegation);
        }
    }

    function _storeGuardianMappings(EDFMemberMapping[] memory guardianMappings, uint256 quorum) private {
        if (guardianMappings.length == 0 || quorum == 0 || quorum > guardianMappings.length) {
            revert InvalidGuardianQuorum(quorum, guardianMappings.length);
        }
        for (uint256 i = 0; i < guardianMappings.length; ++i) {
            EDFMemberMapping memory memberMapping = guardianMappings[i];
            if (memberMapping.oldMember == address(0) || memberMapping.newMember == address(0)) {
                revert ZeroAddress("guardian");
            }
            if (!isConfiguredDelegationContract(memberMapping.newMember)) {
                revert UnknownDelegationContract(memberMapping.newMember);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (_guardianMappings[j].oldMember == memberMapping.oldMember) {
                    revert DuplicateAddress(memberMapping.oldMember);
                }
                if (_guardianMappings[j].newMember == memberMapping.newMember) {
                    revert DuplicateAddress(memberMapping.newMember);
                }
            }
            _guardianMappings.push(memberMapping);
        }
    }

    function _storeOracleCommittees(EDFOracleCommittee[] memory committees) private {
        if (committees.length != EXPECTED_COMMITTEES_COUNT) revert InvalidCommitteeCount(committees.length);
        for (uint256 i = 0; i < committees.length; ++i) {
            EDFOracleCommittee memory committee = committees[i];
            uint256 membersCount = committee.memberMappings.length;
            if (
                committee.consensusContract == address(0) || committee.quorum == 0 || committee.quorum > membersCount
                    || membersCount == 0
            ) {
                revert InvalidCommittee(i);
            }
            for (uint256 j = 0; j < i; ++j) {
                if (_oracleCommittees[j].consensusContract == committee.consensusContract) {
                    revert DuplicateAddress(committee.consensusContract);
                }
            }

            _oracleCommittees.push();
            EDFOracleCommittee storage storedCommittee = _oracleCommittees[i];
            storedCommittee.consensusContract = committee.consensusContract;
            storedCommittee.quorum = committee.quorum;
            for (uint256 j = 0; j < membersCount; ++j) {
                EDFMemberMapping memory memberMapping = committee.memberMappings[j];
                if (memberMapping.oldMember == address(0) || memberMapping.newMember == address(0)) {
                    revert InvalidCommittee(i);
                }
                if (!isConfiguredDelegationContract(memberMapping.newMember)) {
                    revert UnknownDelegationContract(memberMapping.newMember);
                }
                for (uint256 k = 0; k < j; ++k) {
                    EDFMemberMapping storage previous = storedCommittee.memberMappings[k];
                    if (previous.oldMember == memberMapping.oldMember) {
                        revert DuplicateAddress(memberMapping.oldMember);
                    }
                    if (previous.newMember == memberMapping.newMember) {
                        revert DuplicateAddress(memberMapping.newMember);
                    }
                }
                storedCommittee.memberMappings.push(memberMapping);
            }
        }
    }

    function _nonZero(address value, string memory field) private pure returns (address) {
        if (value == address(0)) revert ZeroAddress(field);
        return value;
    }
}
