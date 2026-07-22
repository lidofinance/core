// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {EDFUpgradeConfig} from "contracts/upgrade/EDFUpgradeConfig.sol";
import {EDFUpgradeTemplate} from "contracts/upgrade/EDFUpgradeTemplate.sol";
import {
    EDFDelegationContract,
    EDFMemberMapping,
    EDFOracleCommittee,
    EDFUpgradeParameters
} from "contracts/upgrade/EDFUpgradeTypes.sol";

import {
    EDFDelegationContract__Mock,
    EDFDelegationFactory__Mock,
    EDFDepositSecurityModule__Mock,
    EDFHashConsensus__Mock,
    EDFLidoLocator__Mock,
    EDFLocatorProxy__Mock,
    EDFStakingRouter__Mock,
    EDFUpgradeExecutor
} from "./contracts/EDFUpgradeMocks.sol";
import {EDFUpgradeTemplate__Harness} from "./contracts/EDFUpgradeTemplate__Harness.sol";

contract EDFUpgradeTemplateTest is Test {
    event UpgradeStarted();
    event UpgradeFinished();

    bytes32 internal constant UNVET_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");
    bytes32 internal constant ATTEST_MESSAGE_BASE = 0x1085395a994e25b1b3d0ea7937b7395495fb405b31c7d22dbc3976a6bd01f2bf;
    bytes32 internal constant PAUSE_MESSAGE_BASE = 0x9c4c40205558f12027f21204d6218b8006985b7a6359bcab15404bcc3e3fa122;
    bytes32 internal constant UNVET_MESSAGE_BASE = 0x2dd9727393562ed11c29080a884630e2d3a7078e71b313e713a8a1ef68948f6a;

    address internal constant DEPOSIT_CONTRACT = address(0xD001);
    address internal constant OLD_GUARDIAN = address(0x5001);

    EDFUpgradeExecutor internal executor;
    EDFUpgradeTemplate__Harness internal template;
    EDFUpgradeConfig internal config;
    EDFDelegationFactory__Mock internal factory;
    EDFStakingRouter__Mock internal stakingRouter;
    EDFDepositSecurityModule__Mock internal oldDSM;
    EDFDepositSecurityModule__Mock internal newDSM;
    EDFLidoLocator__Mock internal oldLocatorImplementation;
    EDFLidoLocator__Mock internal newLocatorImplementation;
    EDFLocatorProxy__Mock internal locator;
    EDFHashConsensus__Mock[4] internal committees;
    EDFDelegationContract__Mock[5] internal delegationContracts;
    uint256 internal expiry;

    function setUp() public {
        executor = new EDFUpgradeExecutor();

        uint256[] memory stakingModuleIds = new uint256[](2);
        stakingModuleIds[0] = 1;
        stakingModuleIds[1] = 2;
        stakingRouter = new EDFStakingRouter__Mock(stakingModuleIds);

        address[] memory oldGuardians = new address[](1);
        oldGuardians[0] = OLD_GUARDIAN;
        oldDSM = new EDFDepositSecurityModule__Mock(
            4,
            address(stakingRouter),
            DEPOSIT_CONTRACT,
            address(executor),
            6646,
            200,
            oldGuardians,
            1
        );

        for (uint256 i = 0; i < delegationContracts.length; ++i) {
            delegationContracts[i] = new EDFDelegationContract__Mock(
                address(uint160(0x8001 + i)),
                address(uint160(0x9001 + i)),
                i
            );
        }

        address[] memory newGuardians = new address[](1);
        newGuardians[0] = address(delegationContracts[0]);
        newDSM = new EDFDepositSecurityModule__Mock(
            5,
            address(stakingRouter),
            DEPOSIT_CONTRACT,
            address(executor),
            6646,
            200,
            newGuardians,
            1
        );
        newDSM.setPrefixes(
            keccak256(abi.encodePacked(ATTEST_MESSAGE_BASE, block.chainid, address(newDSM))),
            keccak256(abi.encodePacked(PAUSE_MESSAGE_BASE, block.chainid, address(newDSM))),
            keccak256(abi.encodePacked(UNVET_MESSAGE_BASE, block.chainid, address(newDSM)))
        );

        for (uint256 moduleId = 1; moduleId <= 2; ++moduleId) {
            oldDSM.setMinDepositDistancePassed(moduleId, true);
            newDSM.setMinDepositDistancePassed(moduleId, true);
        }
        stakingRouter.grantRole(UNVET_ROLE, address(oldDSM));

        for (uint256 i = 0; i < committees.length; ++i) {
            address[] memory members = new address[](1);
            members[0] = _oldOracleMember(i);
            committees[i] = new EDFHashConsensus__Mock(members, 1);
        }

        factory = new EDFDelegationFactory__Mock();
        EDFLidoLocator__Mock.Config memory locatorConfig = _locatorConfig(address(oldDSM));
        oldLocatorImplementation = new EDFLidoLocator__Mock(locatorConfig);
        locatorConfig.depositSecurityModule = address(newDSM);
        newLocatorImplementation = new EDFLidoLocator__Mock(locatorConfig);
        locator = new EDFLocatorProxy__Mock(address(oldLocatorImplementation), address(executor));

        expiry = block.timestamp + 30 days;
        template = new EDFUpgradeTemplate__Harness(_makeParams(), expiry);
        executor.setTemplate(template);
        config = EDFUpgradeConfig(template.CONFIG());
    }

    function test_constructorCreatesImmutableConfig() public view {
        assertEq(config.CHAIN_ID(), block.chainid);
        assertEq(config.AGENT(), address(executor));
        assertEq(config.guardiansCount(), 1);
        assertEq(config.oracleCommitteesCount(), 4);
        assertEq(config.oracleMappingsCount(), 4);
        assertEq(config.delegationContractsCount(), 5);
        assertEq(template.EXPIRE_SINCE_INCLUSIVE(), expiry);
    }

    function test_revertsForInvalidExpiry() public {
        vm.expectRevert(EDFUpgradeTemplate.InvalidExpiry.selector);
        new EDFUpgradeTemplate__Harness(_makeParams(), block.timestamp);
    }

    function test_revertsForWrongChain() public {
        EDFUpgradeParameters memory params = _makeParams();
        params.chainId = block.chainid + 1;
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.InvalidChainId.selector, block.chainid, params.chainId)
        );
        new EDFUpgradeTemplate__Harness(params, expiry);
    }

    function test_onlyAgentCanStartAndFinish() public {
        vm.expectRevert(EDFUpgradeTemplate.OnlyAgentCanUpgrade.selector);
        template.startUpgrade();

        vm.expectRevert(EDFUpgradeTemplate.OnlyAgentCanUpgrade.selector);
        template.finishUpgrade();
    }

    function test_finishBeforeStartReverts() public {
        vm.expectRevert(EDFUpgradeTemplate.StartAndFinishMustBeInSameTx.selector);
        executor.finishOnly();
    }

    function test_startTwiceInOneTransactionRevertsAtomically() public {
        vm.expectRevert(EDFUpgradeTemplate.StartAlreadyCalledInThisTx.selector);
        executor.startTwice();
        assertEq(template.upgradeBlockNumber(), 0);
    }

    function test_expiryBoundaryIsInclusive() public {
        vm.warp(expiry);
        vm.expectRevert(EDFUpgradeTemplate.Expired.selector);
        executor.startOnly();
    }

    function test_successfulAtomicLifecycleValidatesRealState() public {
        vm.expectEmit(true, true, true, true, address(template));
        emit UpgradeStarted();
        vm.expectEmit(true, true, true, true, address(template));
        emit UpgradeFinished();
        executor.enact();

        assertEq(template.upgradeBlockNumber(), block.number);
        assertTrue(template.isUpgradeFinished());
        assertEq(locator.proxy__getImplementation(), address(newLocatorImplementation));
        assertEq(ILidoLocator(address(locator)).depositSecurityModule(), address(newDSM));
        assertFalse(stakingRouter.hasRole(UNVET_ROLE, address(oldDSM)));
        assertTrue(stakingRouter.hasRole(UNVET_ROLE, address(newDSM)));
        assertEq(stakingRouter.getRoleMemberCount(UNVET_ROLE), 1);

        for (uint256 i = 0; i < committees.length; ++i) {
            assertFalse(committees[i].getIsMember(_oldOracleMember(i)));
            assertTrue(committees[i].getIsMember(address(delegationContracts[i + 1])));
            assertEq(committees[i].getQuorum(), 1);
        }
    }

    function test_finishedUpgradeCannotBeReplayed() public {
        executor.enact();
        vm.expectRevert(EDFUpgradeTemplate.UpgradeAlreadyFinished.selector);
        executor.enact();
    }

    function test_preValidationFailureRollsBackStart() public {
        oldDSM.setDepositsPaused(true);
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.InvalidFlag.selector, bytes32("old-dsm-paused"), address(oldDSM))
        );
        executor.startOnly();
        assertEq(template.upgradeBlockNumber(), 0);
    }

    function test_rejectsUnsafeConsensusState() public {
        committees[0].setConsensusState(keccak256("report"), false);
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.UnsafeConsensusState.selector, address(committees[0]))
        );
        executor.startOnly();
    }

    function test_rejectsFailedDepositDistance() public {
        newDSM.setMinDepositDistancePassed(2, false);
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.InvalidUint.selector, bytes32("new-dsm-deposit-distance"), 2, 0)
        );
        executor.startOnly();
    }

    function test_rejectsUnexpectedFactoryCode() public {
        vm.etch(address(factory), hex"60006000");
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.InvalidDelegationContract.selector, address(factory))
        );
        executor.startOnly();
    }

    function test_rejectsUnexpectedDelegationRuntimeCode() public {
        vm.etch(address(delegationContracts[0]), hex"60006000");
        vm.expectRevert(
            abi.encodeWithSelector(
                EDFUpgradeTemplate.InvalidDelegationContract.selector,
                address(delegationContracts[0])
            )
        );
        executor.startOnly();
    }

    function test_rejectsAdditionalUnvettingRoleHolder() public {
        stakingRouter.grantRole(UNVET_ROLE, address(0xDEAD));
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.InvalidUint.selector, bytes32("unvet-role-members"), 2, 1)
        );
        executor.startOnly();
    }

    function test_rejectsInvalidOracleMembership() public {
        committees[0].removeMember(_oldOracleMember(0), 1);
        committees[0].addMember(address(0xDEAD), 1);
        vm.expectRevert(abi.encodeWithSelector(EDFUpgradeTemplate.InvalidMembers.selector, address(committees[0])));
        executor.startOnly();
    }

    function test_rejectsInvalidNewDSMPrefix() public {
        newDSM.setPrefixes(bytes32(uint256(1)), newDSM.PAUSE_MESSAGE_PREFIX(), newDSM.UNVET_MESSAGE_PREFIX());
        vm.expectRevert(
            abi.encodeWithSelector(
                EDFUpgradeTemplate.InvalidUint.selector,
                bytes32("new-dsm-attest-prefix"),
                1,
                uint256(keccak256(abi.encodePacked(ATTEST_MESSAGE_BASE, block.chainid, address(newDSM))))
            )
        );
        executor.startOnly();
    }

    function test_postValidationFailureRollsBackWholeAtomicLifecycle() public {
        vm.expectRevert(
            abi.encodeWithSelector(EDFUpgradeTemplate.InvalidUint.selector, bytes32("unvet-role-members"), 0, 1)
        );
        executor.enactWithoutRoleGrant();

        assertEq(template.upgradeBlockNumber(), 0);
        assertFalse(template.isUpgradeFinished());
        assertEq(locator.proxy__getImplementation(), address(oldLocatorImplementation));
        assertTrue(stakingRouter.hasRole(UNVET_ROLE, address(oldDSM)));
        assertFalse(stakingRouter.hasRole(UNVET_ROLE, address(newDSM)));
        for (uint256 i = 0; i < committees.length; ++i) {
            assertTrue(committees[i].getIsMember(_oldOracleMember(i)));
            assertFalse(committees[i].getIsMember(address(delegationContracts[i + 1])));
        }
    }

    function test_configRejectsDuplicateGuardianMappings() public {
        EDFUpgradeParameters memory params = _makeParams();
        params.guardianMappings = new EDFMemberMapping[](2);
        params.guardianMappings[0] = EDFMemberMapping({
            oldMember: OLD_GUARDIAN,
            newMember: address(delegationContracts[0])
        });
        params.guardianMappings[1] = EDFMemberMapping({
            oldMember: OLD_GUARDIAN,
            newMember: address(delegationContracts[1])
        });
        params.guardianQuorum = 1;

        vm.expectRevert(abi.encodeWithSelector(EDFUpgradeConfig.DuplicateAddress.selector, OLD_GUARDIAN));
        new EDFUpgradeTemplate__Harness(params, expiry);
    }

    function test_configRejectsUnknownDelegationContract() public {
        EDFUpgradeParameters memory params = _makeParams();
        params.guardianMappings[0].newMember = address(0xDEAD);

        vm.expectRevert(abi.encodeWithSelector(EDFUpgradeConfig.UnknownDelegationContract.selector, address(0xDEAD)));
        new EDFUpgradeTemplate__Harness(params, expiry);
    }

    function test_configRejectsInvalidCommitteeQuorum() public {
        EDFUpgradeParameters memory params = _makeParams();
        params.oracleCommittees[0].quorum = 2;

        vm.expectRevert(abi.encodeWithSelector(EDFUpgradeConfig.InvalidCommittee.selector, 0));
        new EDFUpgradeTemplate__Harness(params, expiry);
    }

    function test_configRejectsMissingDelegationRuntimeCodeHash() public {
        EDFUpgradeParameters memory params = _makeParams();
        params.delegationContracts[0].runtimeCodeHash = bytes32(0);

        vm.expectRevert(abi.encodeWithSelector(EDFUpgradeConfig.InvalidDelegationContract.selector, 0));
        new EDFUpgradeTemplate__Harness(params, expiry);
    }

    function _makeParams() private view returns (EDFUpgradeParameters memory params) {
        params.chainId = block.chainid;
        params.locator = address(locator);
        params.oldLocatorImplementation = address(oldLocatorImplementation);
        params.newLocatorImplementation = address(newLocatorImplementation);
        params.locatorAdmin = address(executor);
        params.agent = address(executor);
        params.voting = address(0x1005);
        params.dualGovernance = address(0x1006);
        params.stakingRouter = address(stakingRouter);
        params.oldDepositSecurityModule = address(oldDSM);
        params.newDepositSecurityModule = address(newDSM);
        params.oldDepositSecurityModuleVersion = 4;
        params.delegationFactory = address(factory);
        params.delegationFactoryRuntimeCodeHash = address(factory).codehash;
        params.pauseIntentValidityPeriodBlocks = 6646;
        params.maxOperatorsPerUnvetting = 200;
        params.guardianQuorum = 1;

        params.delegationContracts = new EDFDelegationContract[](delegationContracts.length);
        for (uint256 i = 0; i < delegationContracts.length; ++i) {
            params.delegationContracts[i] = EDFDelegationContract({
                delegationContract: address(delegationContracts[i]),
                owner: address(uint160(0x8001 + i)),
                delegate: address(uint160(0x9001 + i)),
                cooldown: i,
                runtimeCodeHash: address(delegationContracts[i]).codehash
            });
        }

        params.guardianMappings = new EDFMemberMapping[](1);
        params.guardianMappings[0] = EDFMemberMapping({
            oldMember: OLD_GUARDIAN,
            newMember: address(delegationContracts[0])
        });

        params.oracleCommittees = new EDFOracleCommittee[](committees.length);
        for (uint256 i = 0; i < committees.length; ++i) {
            EDFMemberMapping[] memory mappings = new EDFMemberMapping[](1);
            mappings[0] = EDFMemberMapping({
                oldMember: _oldOracleMember(i),
                newMember: address(delegationContracts[i + 1])
            });
            params.oracleCommittees[i] = EDFOracleCommittee({
                consensusContract: address(committees[i]),
                quorum: 1,
                memberMappings: mappings
            });
        }
    }

    function _locatorConfig(
        address depositSecurityModule
    ) private view returns (EDFLidoLocator__Mock.Config memory locatorConfig) {
        locatorConfig.accountingOracle = address(0xA001);
        locatorConfig.depositSecurityModule = depositSecurityModule;
        locatorConfig.elRewardsVault = address(0xA002);
        locatorConfig.lido = address(0xA003);
        locatorConfig.oracleReportSanityChecker = address(0xA004);
        locatorConfig.postTokenRebaseReceiver = address(0xA005);
        locatorConfig.burner = address(0xA006);
        locatorConfig.stakingRouter = address(stakingRouter);
        locatorConfig.treasury = address(0xA007);
        locatorConfig.validatorsExitBusOracle = address(0xA008);
        locatorConfig.withdrawalQueue = address(0xA009);
        locatorConfig.withdrawalVault = address(0xA00A);
        locatorConfig.oracleDaemonConfig = address(0xA00B);
        locatorConfig.accounting = address(0xA00C);
        locatorConfig.predepositGuarantee = address(0xA00D);
        locatorConfig.wstETH = address(0xA00E);
        locatorConfig.vaultHub = address(0xA00F);
        locatorConfig.vaultFactory = address(0xA010);
        locatorConfig.lazyOracle = address(0xA011);
        locatorConfig.operatorGrid = address(0xA012);
        locatorConfig.topUpGateway = address(0xA013);
        locatorConfig.validatorExitDelayVerifier = address(0xA014);
        locatorConfig.triggerableWithdrawalsGateway = address(0xA015);
        locatorConfig.consolidationGateway = address(0xA016);
    }

    function _oldOracleMember(uint256 index) private pure returns (address) {
        return address(uint160(0x6001 + index));
    }
}
