// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";
import {EDFUpgradeConfig} from "contracts/upgrade/EDFUpgradeConfig.sol";
import {EDFUpgradeTemplate} from "contracts/upgrade/EDFUpgradeTemplate.sol";
import {IEDFHashConsensus} from "contracts/upgrade/EDFUpgradeTypes.sol";

contract EDFLidoLocator__Mock {
    struct Config {
        address accountingOracle;
        address depositSecurityModule;
        address elRewardsVault;
        address lido;
        address oracleReportSanityChecker;
        address postTokenRebaseReceiver;
        address burner;
        address stakingRouter;
        address treasury;
        address validatorsExitBusOracle;
        address withdrawalQueue;
        address withdrawalVault;
        address oracleDaemonConfig;
        address accounting;
        address predepositGuarantee;
        address wstETH;
        address vaultHub;
        address vaultFactory;
        address lazyOracle;
        address operatorGrid;
        address topUpGateway;
        address validatorExitDelayVerifier;
        address triggerableWithdrawalsGateway;
        address consolidationGateway;
    }

    address public immutable accountingOracle;
    address public immutable depositSecurityModule;
    address public immutable elRewardsVault;
    address public immutable lido;
    address public immutable oracleReportSanityChecker;
    address public immutable postTokenRebaseReceiver;
    address public immutable burner;
    address public immutable stakingRouter;
    address public immutable treasury;
    address public immutable validatorsExitBusOracle;
    address public immutable withdrawalQueue;
    address public immutable withdrawalVault;
    address public immutable oracleDaemonConfig;
    address public immutable accounting;
    address public immutable predepositGuarantee;
    address public immutable wstETH;
    address public immutable vaultHub;
    address public immutable vaultFactory;
    address public immutable lazyOracle;
    address public immutable operatorGrid;
    address public immutable topUpGateway;
    address public immutable validatorExitDelayVerifier;
    address public immutable triggerableWithdrawalsGateway;
    address public immutable consolidationGateway;

    constructor(Config memory config) {
        accountingOracle = config.accountingOracle;
        depositSecurityModule = config.depositSecurityModule;
        elRewardsVault = config.elRewardsVault;
        lido = config.lido;
        oracleReportSanityChecker = config.oracleReportSanityChecker;
        postTokenRebaseReceiver = config.postTokenRebaseReceiver;
        burner = config.burner;
        stakingRouter = config.stakingRouter;
        treasury = config.treasury;
        validatorsExitBusOracle = config.validatorsExitBusOracle;
        withdrawalQueue = config.withdrawalQueue;
        withdrawalVault = config.withdrawalVault;
        oracleDaemonConfig = config.oracleDaemonConfig;
        accounting = config.accounting;
        predepositGuarantee = config.predepositGuarantee;
        wstETH = config.wstETH;
        vaultHub = config.vaultHub;
        vaultFactory = config.vaultFactory;
        lazyOracle = config.lazyOracle;
        operatorGrid = config.operatorGrid;
        topUpGateway = config.topUpGateway;
        validatorExitDelayVerifier = config.validatorExitDelayVerifier;
        triggerableWithdrawalsGateway = config.triggerableWithdrawalsGateway;
        consolidationGateway = config.consolidationGateway;
    }
}

contract EDFLocatorProxy__Mock {
    address private _implementation;
    address private _admin;

    constructor(address implementation, address admin) {
        _implementation = implementation;
        _admin = admin;
    }

    function proxy__getImplementation() external view returns (address) {
        return _implementation;
    }

    function proxy__getAdmin() external view returns (address) {
        return _admin;
    }

    function proxy__upgradeTo(address implementation) external {
        require(msg.sender == _admin, "NOT_ADMIN");
        _implementation = implementation;
    }

    fallback() external {
        address implementation = _implementation;
        assembly ("memory-safe") {
            calldatacopy(0, 0, calldatasize())
            let success := staticcall(gas(), implementation, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            if iszero(success) {
                revert(0, returndatasize())
            }
            return(0, returndatasize())
        }
    }
}

contract EDFDepositSecurityModule__Mock {
    uint256 public immutable VERSION;
    address public immutable STAKING_ROUTER;
    address public immutable DEPOSIT_CONTRACT;

    bytes32 public ATTEST_MESSAGE_PREFIX;
    bytes32 public PAUSE_MESSAGE_PREFIX;
    bytes32 public UNVET_MESSAGE_PREFIX;

    address private _owner;
    uint256 private _pauseIntentValidityPeriodBlocks;
    uint256 private _maxOperatorsPerUnvetting;
    uint256 private _guardianQuorum;
    bool private _depositsPaused;
    address[] private _guardians;
    mapping(address guardian => bool) private _isGuardian;
    mapping(uint256 moduleId => bool) private _isMinDepositDistancePassed;

    constructor(
        uint256 version,
        address stakingRouter,
        address depositContract,
        address owner,
        uint256 pauseIntentValidityPeriodBlocks,
        uint256 maxOperatorsPerUnvetting,
        address[] memory guardians,
        uint256 guardianQuorum
    ) {
        VERSION = version;
        STAKING_ROUTER = stakingRouter;
        DEPOSIT_CONTRACT = depositContract;
        _owner = owner;
        _pauseIntentValidityPeriodBlocks = pauseIntentValidityPeriodBlocks;
        _maxOperatorsPerUnvetting = maxOperatorsPerUnvetting;
        _guardianQuorum = guardianQuorum;
        _guardians = guardians;
        for (uint256 i = 0; i < guardians.length; ++i) {
            _isGuardian[guardians[i]] = true;
        }
    }

    function getOwner() external view returns (address) {
        return _owner;
    }

    function getPauseIntentValidityPeriodBlocks() external view returns (uint256) {
        return _pauseIntentValidityPeriodBlocks;
    }

    function getMaxOperatorsPerUnvetting() external view returns (uint256) {
        return _maxOperatorsPerUnvetting;
    }

    function getGuardianQuorum() external view returns (uint256) {
        return _guardianQuorum;
    }

    function getGuardians() external view returns (address[] memory) {
        return _guardians;
    }

    function isGuardian(address guardian) external view returns (bool) {
        return _isGuardian[guardian];
    }

    function isDepositsPaused() external view returns (bool) {
        return _depositsPaused;
    }

    function isMinDepositDistancePassed(uint256 moduleId) external view returns (bool) {
        return _isMinDepositDistancePassed[moduleId];
    }

    function setPrefixes(bytes32 attest, bytes32 pause, bytes32 unvet) external {
        ATTEST_MESSAGE_PREFIX = attest;
        PAUSE_MESSAGE_PREFIX = pause;
        UNVET_MESSAGE_PREFIX = unvet;
    }

    function setDepositsPaused(bool depositsPaused) external {
        _depositsPaused = depositsPaused;
    }

    function setMinDepositDistancePassed(uint256 moduleId, bool passed) external {
        _isMinDepositDistancePassed[moduleId] = passed;
    }
}

contract EDFStakingRouter__Mock {
    mapping(bytes32 role => mapping(address account => bool)) private _hasRole;
    mapping(bytes32 role => address[]) private _roleMembers;
    uint256[] private _stakingModuleIds;

    constructor(uint256[] memory stakingModuleIds) {
        _stakingModuleIds = stakingModuleIds;
    }

    function getStakingModuleIds() external view returns (uint256[] memory) {
        return _stakingModuleIds;
    }

    function hasRole(bytes32 role, address account) external view returns (bool) {
        return _hasRole[role][account];
    }

    function getRoleMemberCount(bytes32 role) external view returns (uint256) {
        return _roleMembers[role].length;
    }

    function grantRole(bytes32 role, address account) external {
        if (_hasRole[role][account]) return;
        _hasRole[role][account] = true;
        _roleMembers[role].push(account);
    }

    function revokeRole(bytes32 role, address account) external {
        if (!_hasRole[role][account]) return;
        _hasRole[role][account] = false;
        address[] storage members = _roleMembers[role];
        for (uint256 i = 0; i < members.length; ++i) {
            if (members[i] == account) {
                members[i] = members[members.length - 1];
                members.pop();
                return;
            }
        }
    }
}

contract EDFHashConsensus__Mock {
    address[] private _members;
    mapping(address member => bool) private _isMember;
    uint256 private _quorum;
    bytes32 private _consensusReport;
    bool private _isReportProcessing;

    constructor(address[] memory members, uint256 quorum) {
        _members = members;
        _quorum = quorum;
        for (uint256 i = 0; i < members.length; ++i) {
            _isMember[members[i]] = true;
        }
    }

    function getMembers() external view returns (address[] memory addresses, uint256[] memory lastReportedRefSlots) {
        addresses = _members;
        lastReportedRefSlots = new uint256[](_members.length);
    }

    function getIsMember(address member) external view returns (bool) {
        return _isMember[member];
    }

    function getQuorum() external view returns (uint256) {
        return _quorum;
    }

    function getConsensusState() external view returns (uint256, bytes32, bool) {
        return (1, _consensusReport, _isReportProcessing);
    }

    function addMember(address member, uint256 quorum) external {
        require(!_isMember[member], "DUPLICATE_MEMBER");
        _isMember[member] = true;
        _members.push(member);
        _quorum = quorum;
    }

    function removeMember(address member, uint256 quorum) external {
        require(_isMember[member], "MEMBER_NOT_FOUND");
        _isMember[member] = false;
        for (uint256 i = 0; i < _members.length; ++i) {
            if (_members[i] == member) {
                _members[i] = _members[_members.length - 1];
                _members.pop();
                break;
            }
        }
        _quorum = quorum;
    }

    function setConsensusState(bytes32 consensusReport, bool isReportProcessing) external {
        _consensusReport = consensusReport;
        _isReportProcessing = isReportProcessing;
    }
}

contract EDFDelegationFactory__Mock {}

contract EDFDelegationContract__Mock {
    address private immutable _owner;
    uint256 private immutable _cooldown;
    address private _delegate;
    bool private _terminated;
    bool private _supportsERC1271 = true;

    constructor(address owner_, address delegate_, uint256 cooldown_) {
        _owner = owner_;
        _delegate = delegate_;
        _cooldown = cooldown_;
    }

    function owner() external view returns (address) {
        return _owner;
    }

    function getDelegate() external view returns (address) {
        return _delegate;
    }

    function getCooldown() external view returns (uint256) {
        return _cooldown;
    }

    function isTerminated() external view returns (bool) {
        return _terminated;
    }

    function supportsInterface(bytes4 interfaceId) external view returns (bool) {
        return _supportsERC1271 && interfaceId == 0x1626ba7e;
    }

    function setTerminated(bool terminated) external {
        _terminated = terminated;
    }
}

contract EDFUpgradeExecutor {
    bytes32 private constant STAKING_MODULE_UNVETTING_ROLE = keccak256("STAKING_MODULE_UNVETTING_ROLE");

    EDFUpgradeTemplate public template;

    function setTemplate(EDFUpgradeTemplate newTemplate) external {
        require(address(template) == address(0), "TEMPLATE_ALREADY_SET");
        template = newTemplate;
    }

    function startOnly() external {
        template.startUpgrade();
    }

    function finishOnly() external {
        template.finishUpgrade();
    }

    function startTwice() external {
        template.startUpgrade();
        template.startUpgrade();
    }

    function enact() external {
        _enact(true);
    }

    function enactWithoutRoleGrant() external {
        _enact(false);
    }

    function _enact(bool grantNewDSMRole) private {
        template.startUpgrade();
        EDFUpgradeConfig config = EDFUpgradeConfig(template.CONFIG());

        uint256 committeesCount = config.oracleCommitteesCount();
        for (uint256 i = 0; i < committeesCount; ++i) {
            (address consensusAddress, uint256 quorum) = config.oracleCommittee(i);
            IEDFHashConsensus consensus = IEDFHashConsensus(consensusAddress);
            uint256 mappingsCount = config.oracleCommitteeMappingsCount(i);
            for (uint256 j = 0; j < mappingsCount; ++j) {
                (address oldMember, address newMember) = config.oracleCommitteeMapping(i, j);
                consensus.removeMember(oldMember, quorum);
                consensus.addMember(newMember, quorum);
            }
        }

        IOssifiableProxy(config.LOCATOR()).proxy__upgradeTo(config.NEW_LOCATOR_IMPLEMENTATION());
        IAccessControl(config.STAKING_ROUTER()).revokeRole(
            STAKING_MODULE_UNVETTING_ROLE,
            config.OLD_DEPOSIT_SECURITY_MODULE()
        );
        if (grantNewDSMRole) {
            IAccessControl(config.STAKING_ROUTER()).grantRole(
                STAKING_MODULE_UNVETTING_ROLE,
                config.NEW_DEPOSIT_SECURITY_MODULE()
            );
        }
        template.finishUpgrade();
    }
}
