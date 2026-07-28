// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.25;

struct EDFMemberMapping {
    address oldMember;
    address newMember;
}

struct EDFOracleCommittee {
    address consensusContract;
    uint256 quorum;
    EDFMemberMapping[] memberMappings;
}

struct EDFDelegationContract {
    address delegationContract;
    address owner;
    address delegate;
    uint256 cooldown;
    bytes32 runtimeCodeHash;
}

struct EDFUpgradeParameters {
    uint256 chainId;
    address locator;
    address oldLocatorImplementation;
    address newLocatorImplementation;
    address locatorAdmin;
    address agent;
    address voting;
    address dualGovernance;
    address stakingRouter;
    address oldDepositSecurityModule;
    address newDepositSecurityModule;
    uint256 oldDepositSecurityModuleVersion;
    address delegationFactory;
    bytes32 delegationFactoryRuntimeCodeHash;
    uint256 pauseIntentValidityPeriodBlocks;
    uint256 maxOperatorsPerUnvetting;
    uint256 guardianQuorum;
    EDFMemberMapping[] guardianMappings;
    EDFOracleCommittee[] oracleCommittees;
    EDFDelegationContract[] delegationContracts;
}

interface IEDFHashConsensus {
    function getMembers() external view returns (address[] memory addresses, uint256[] memory lastReportedRefSlots);
    function getIsMember(address member) external view returns (bool);
    function getQuorum() external view returns (uint256);
    function addMember(address member, uint256 quorum) external;
    function removeMember(address member, uint256 quorum) external;
}

interface IEDFDepositSecurityModule {
    function VERSION() external view returns (uint256);
    function STAKING_ROUTER() external view returns (address);
    function DEPOSIT_CONTRACT() external view returns (address);
    function ATTEST_MESSAGE_PREFIX() external view returns (bytes32);
    function PAUSE_MESSAGE_PREFIX() external view returns (bytes32);
    function UNVET_MESSAGE_PREFIX() external view returns (bytes32);
    function getOwner() external view returns (address);
    function getPauseIntentValidityPeriodBlocks() external view returns (uint256);
    function getMaxOperatorsPerUnvetting() external view returns (uint256);
    function getGuardianQuorum() external view returns (uint256);
    function getGuardians() external view returns (address[] memory);
    function isGuardian(address guardian) external view returns (bool);
    function isDepositsPaused() external view returns (bool);
}

interface IEDFDelegationContract {
    function owner() external view returns (address);
    function getDelegate() external view returns (address);
    function getCooldown() external view returns (uint256);
    function isTerminated() external view returns (bool);
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}
