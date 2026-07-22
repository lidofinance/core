// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {
    EDFDelegationContract,
    EDFMemberMapping,
    EDFOracleCommittee,
    EDFUpgradeParameters
} from "contracts/upgrade/EDFUpgradeTypes.sol";

abstract contract EDFUpgradeTestBase {
    uint256 internal constant GUARDIANS_COUNT = 7;
    uint256 internal constant ORACLE_MEMBERS_COUNT = 10;
    uint256 internal constant COMMITTEES_COUNT = 4;
    uint256 internal constant DELEGATION_CONTRACTS_COUNT = GUARDIANS_COUNT + ORACLE_MEMBERS_COUNT;

    address internal constant LOCATOR = address(0x1001);
    address internal constant OLD_LOCATOR_IMPLEMENTATION = address(0x1002);
    address internal constant NEW_LOCATOR_IMPLEMENTATION = address(0x1003);
    address internal constant LOCATOR_ADMIN = address(0x1004);
    address internal constant VOTING = address(0x1005);
    address internal constant DUAL_GOVERNANCE = address(0x1006);
    address internal constant STAKING_ROUTER = address(0x1007);
    address internal constant OLD_DSM = address(0x1008);
    address internal constant NEW_DSM = address(0x1009);
    address internal constant FACTORY = address(0x1010);

    function _makeParams(address agent) internal view returns (EDFUpgradeParameters memory params) {
        params.chainId = block.chainid;
        params.locator = LOCATOR;
        params.oldLocatorImplementation = OLD_LOCATOR_IMPLEMENTATION;
        params.newLocatorImplementation = NEW_LOCATOR_IMPLEMENTATION;
        params.locatorAdmin = LOCATOR_ADMIN;
        params.agent = agent;
        params.voting = VOTING;
        params.dualGovernance = DUAL_GOVERNANCE;
        params.stakingRouter = STAKING_ROUTER;
        params.oldDepositSecurityModule = OLD_DSM;
        params.newDepositSecurityModule = NEW_DSM;
        params.oldDepositSecurityModuleVersion = 4;
        params.delegationFactory = FACTORY;
        params.delegationFactoryRuntimeCodeHash = keccak256("factory-runtime-code");
        params.pauseIntentValidityPeriodBlocks = 6646;
        params.maxOperatorsPerUnvetting = 200;
        params.guardianQuorum = 2;

        params.delegationContracts = new EDFDelegationContract[](DELEGATION_CONTRACTS_COUNT);
        for (uint256 i = 0; i < DELEGATION_CONTRACTS_COUNT; ++i) {
            params.delegationContracts[i] = EDFDelegationContract({
                delegationContract: _delegationContract(i),
                owner: address(uint160(0x3001 + i)),
                delegate: address(uint160(0x4001 + i)),
                cooldown: i,
                runtimeCodeHash: keccak256(abi.encode("delegation-runtime-code", i))
            });
        }

        params.guardianMappings = new EDFMemberMapping[](GUARDIANS_COUNT);
        for (uint256 i = 0; i < GUARDIANS_COUNT; ++i) {
            params.guardianMappings[i] = EDFMemberMapping({
                oldMember: _oldGuardian(i),
                newMember: _delegationContract(i)
            });
        }

        params.oracleCommittees = new EDFOracleCommittee[](COMMITTEES_COUNT);
        for (uint256 committeeIndex = 0; committeeIndex < COMMITTEES_COUNT; ++committeeIndex) {
            EDFMemberMapping[] memory mappings = new EDFMemberMapping[](ORACLE_MEMBERS_COUNT);
            for (uint256 mappingIndex = 0; mappingIndex < ORACLE_MEMBERS_COUNT; ++mappingIndex) {
                uint256 memberIndex = _oracleMemberIndex(committeeIndex, mappingIndex);
                mappings[mappingIndex] = EDFMemberMapping({
                    oldMember: _oldOracleMember(memberIndex),
                    newMember: _delegationContract(GUARDIANS_COUNT + memberIndex)
                });
            }
            params.oracleCommittees[committeeIndex] = EDFOracleCommittee({
                consensusContract: _consensusContract(committeeIndex),
                quorum: 6,
                memberMappings: mappings
            });
        }
    }

    function _delegationContract(uint256 index) internal pure returns (address) {
        return address(uint160(0x2001 + index));
    }

    function _oldGuardian(uint256 index) internal pure returns (address) {
        if (index == 0) return 0x4E93C8c7B06F1CEEb03A8e13B0371b35F93d3257;
        if (index == 1) return 0x2aD1cBE1109376aD6f9D714c29c9A7FF452300FE;
        if (index == 2) return 0x89C102120452AfdFb63f2D4231C5CE3e939f393b;
        if (index == 3) return 0x1be2A219CBD0F18B825a4dDd580F7b3B33Bacb41;
        if (index == 4) return 0xEf302FFC6830FbC464cDFFA84Fa4d5699aA8f06A;
        if (index == 5) return 0xcc1fFeb60ee3A3Cb6711E5D191339b0aF263328C;
        if (index == 6) return 0x8C4C15870d27c1194B6893F6B94DD0CE9C2c8ba2;
        revert("INVALID_GUARDIAN_INDEX");
    }

    function _oldOracleMember(uint256 index) internal pure returns (address) {
        if (index == 0) return 0x43C45C2455C49eed320F463fF4f1Ece3D2BF5aE2;
        if (index == 1) return 0x948A62cc0414979dc7aa9364BA5b96ECb29f8736;
        if (index == 2) return 0x1932f53B1457a5987791a40Ba91f71c5Efd5788F;
        if (index == 3) return 0xf7aE520e99ed3C41180B5E12681d31Aa7302E4e5;
        if (index == 4) return 0x99B2B75F490fFC9A29E4E1f5987BE8e30E690aDF;
        if (index == 5) return 0x219743f1911d84B32599BdC2Df21fC8Dba6F81a2;
        if (index == 6) return 0xD3b1e36A372Ca250eefF61f90E833Ca070559970;
        if (index == 7) return 0x4c75FA734a39f3a21C57e583c1c29942F021C6B7;
        if (index == 8) return 0xfe43A8B0b481Ae9fB1862d31826532047d2d538c;
        if (index == 9) return 0xcA80ee7313A315879f326105134F938676Cfd7a9;
        revert("INVALID_ORACLE_MEMBER_INDEX");
    }

    function _consensusContract(uint256 index) internal pure returns (address) {
        if (index == 0) return 0x32EC59a78abaca3f91527aeB2008925D5AaC1eFC;
        if (index == 1) return 0x30308CD8844fb2DB3ec4D056F1d475a802DCA07c;
        if (index == 2) return 0x54f74a10e4397dDeF85C4854d9dfcA129D72C637;
        if (index == 3) return 0x920883908A78c1554f682006a8aB32E62Be09F33;
        revert("INVALID_COMMITTEE_INDEX");
    }

    function _oracleMemberIndex(uint256 committeeIndex, uint256 mappingIndex) internal pure returns (uint256) {
        if (committeeIndex == 0) return mappingIndex;
        if (committeeIndex == 1) {
            if (mappingIndex == 0) return 9;
            if (mappingIndex == 9) return 0;
            return mappingIndex;
        }

        uint256[10] memory feeOracleOrder = [uint256(3), 1, 2, 5, 8, 7, 6, 9, 4, 0];
        return feeOracleOrder[mappingIndex];
    }
}
