// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";

import {IBurner} from "contracts/common/interfaces/IBurner.sol";
import {IOssifiableProxy} from "contracts/common/interfaces/IOssifiableProxy.sol";

import {OmnibusBase} from "./utils/OmnibusBase.sol";
import {V3Template} from "./V3Template.sol";

import {OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";

interface IEasyTrack {
    function addEVMScriptFactory(address _evmScriptFactory, bytes memory _permissions) external;
}

interface IFinance {
    function newImmediatePayment(address _token, address _receiver, uint256 _amount, string calldata _reference) external;
}

interface IKernel {
    function setApp(bytes32 _namespace, bytes32 _appId, address _app) external;
    function APP_BASES_NAMESPACE() external view returns (bytes32);
}

interface IOracleDaemonConfig {
    function CONFIG_MANAGER_ROLE() external view returns (bytes32);
    function set(string calldata _key, bytes calldata _value) external;
}

interface IStakingRouter {
    function REPORT_REWARDS_MINTED_ROLE() external view returns (bytes32);

    function updateStakingModule(
        uint256 _stakingModuleId,
        uint256 _stakeShareLimit,
        uint256 _priorityExitShareThreshold,
        uint256 _stakingModuleFee,
        uint256 _treasuryFee,
        uint256 _maxDepositsPerBlock,
        uint256 _minDepositBlockDistance
    ) external;

    struct StakingModule {
        uint24 id;
        address stakingModuleAddress;
        uint16 stakingModuleFee;
        uint16 treasuryFee;
        uint16 stakeShareLimit;
        uint8 status;
        string name;
        uint64 lastDepositAt;
        uint256 lastDepositBlock;
        uint256 exitedValidatorsCount;
        uint16 priorityExitShareThreshold;
        uint64 maxDepositsPerBlock;
        uint64 minDepositBlockDistance;
    }

    function getStakingModule(uint256 _stakingModuleId) external view returns (StakingModule memory);
}

interface IAllowedRecipientsRegistry {
    function unsafeSetSpentAmount(uint256 _newSpentAmount) external;
    function setLimitParameters(uint256 _limit, uint256 _periodDurationMonths) external;
}

interface ITimeConstraints {
    function checkTimeAfterTimestampAndEmit(uint40 timestamp) external;
    function checkTimeBeforeTimestampAndEmit(uint40 timestamp) external;
    function checkTimeWithinDayTimeAndEmit(uint32 startDayTime, uint32 endDayTime) external;
}

interface IVaultsAdapter {
    function setVaultJailStatus(address _vault, bool _isInJail) external;
    function updateVaultFees(address _vault, uint16 _infrastructureFeeBP, uint16 _liquidityFeeBP, uint16 _reservationFeeBP) external;
    function forceValidatorExit(address _vault, bytes calldata _pubkeys, address _feeRecipient) external payable;
    function setLiabilitySharesTarget(address _vault, uint256 _liabilitySharesTarget) external;
    function socializeBadDebt(address _debtVault, address _acceptorVault, uint256 _shares) external;
}

/// @title V3VoteScript
/// @notice Script for upgrading Lido protocol components
contract V3VoteScript is OmnibusBase {

    struct ScriptParams {
        address upgradeTemplate;
        bytes32 lidoAppId;

        uint256 stakingModuleId;
        uint256 stakeShareLimit;

        uint256 trpLimitAfter;
        uint256 trpPeriodDurationMonths;

        uint256 odcSlashingReserveWeRightShiftEpochs;
        uint256 odcSlashingReserveWeLeftShiftEpochs;

        address finance;
        address maticToken;
        address lolMultisig;
        uint256 maticAmountWeiForTransfer;
        string transferReference;
        address easyTrackTrpRegistry;

        address timeConstraints;
        uint40 disabledBefore;
        uint40 disabledAfter;
        uint32 enabledDaySpanStart;
        uint32 enabledDaySpanEnd;
    }

    //
    // Constants
    //
    uint256 public constant DG_ITEMS_COUNT = 23;
    uint256 public constant VOTING_ITEMS_COUNT = 10;

    //
    // Immutables
    //
    V3Template public immutable TEMPLATE;

    //
    // Structured storage
    //
    ScriptParams public params;

    constructor(
        ScriptParams memory _params
    ) OmnibusBase(V3Template(_params.upgradeTemplate).VOTING(), V3Template(_params.upgradeTemplate).DUAL_GOVERNANCE()) {
        TEMPLATE = V3Template(_params.upgradeTemplate);

        params = _params;
    }

    function getVotingVoteItems() public view override returns (VoteItem[] memory votingVoteItems) {
        votingVoteItems = new VoteItem[](VOTING_ITEMS_COUNT);
        address easyTrack = TEMPLATE.EASY_TRACK();
        address operatorGrid = TEMPLATE.OPERATOR_GRID();
        address vaultsAdapter = TEMPLATE.VAULTS_ADAPTER();
        uint256 index = 0;

        votingVoteItems[index++] = VoteItem({
            description: "2. Add AlterTiersInOperatorGrid factory to EasyTrack (permissions: operatorGrid, alterTiers)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_ALTER_TIERS_IN_OPERATOR_GRID(),
                    bytes.concat(
                        bytes20(operatorGrid),
                        bytes4(OperatorGrid.alterTiers.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "3. Add RegisterGroupsInOperatorGrid factory to EasyTrack (permissions: operatorGrid, registerGroup + registerTiers)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_REGISTER_GROUPS_IN_OPERATOR_GRID(),
                    bytes.concat(
                        bytes20(operatorGrid),
                        bytes4(OperatorGrid.registerGroup.selector),
                        bytes20(operatorGrid),
                        bytes4(OperatorGrid.registerTiers.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "4. Add RegisterTiersInOperatorGrid factory to EasyTrack (permissions: operatorGrid, registerTiers)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_REGISTER_TIERS_IN_OPERATOR_GRID(),
                    bytes.concat(
                        bytes20(operatorGrid),
                        bytes4(OperatorGrid.registerTiers.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "5. Add UpdateGroupsShareLimitInOperatorGrid factory to EasyTrack (permissions: operatorGrid, updateGroupShareLimit)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_UPDATE_GROUPS_SHARE_LIMIT_IN_OPERATOR_GRID(),
                    bytes.concat(
                        bytes20(operatorGrid),
                        bytes4(OperatorGrid.updateGroupShareLimit.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "6. Add SetJailStatusInOperatorGrid factory to EasyTrack (permissions: vaultsAdapter, setVaultJailStatus)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_SET_JAIL_STATUS_IN_OPERATOR_GRID(),
                    bytes.concat(
                        bytes20(vaultsAdapter),
                        bytes4(IVaultsAdapter.setVaultJailStatus.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "7. Add UpdateVaultsFeesInOperatorGrid factory to EasyTrack (permissions: vaultsAdapter, updateVaultFees)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_UPDATE_VAULTS_FEES_IN_OPERATOR_GRID(),
                    bytes.concat(
                        bytes20(vaultsAdapter),
                        bytes4(IVaultsAdapter.updateVaultFees.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "8. Add ForceValidatorExitsInVaultHub factory to EasyTrack (permissions: vaultsAdapter, forceValidatorExit)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_FORCE_VALIDATOR_EXITS_IN_VAULT_HUB(),
                    bytes.concat(
                        bytes20(vaultsAdapter),
                        bytes4(IVaultsAdapter.forceValidatorExit.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "9. Add SetLiabilitySharesTargetInVaultHub factory to EasyTrack (permissions: vaultsAdapter, setLiabilitySharesTarget)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_SET_LIABILITY_SHARES_TARGET_IN_VAULT_HUB(),
                    bytes.concat(
                        bytes20(vaultsAdapter),
                        bytes4(IVaultsAdapter.setLiabilitySharesTarget.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "10. Add SocializeBadDebtInVaultHub factory to EasyTrack (permissions: vaultsAdapter, socializeBadDebt)",
            call: ScriptCall({
                to: easyTrack,
                data: abi.encodeCall(IEasyTrack.addEVMScriptFactory, (
                    TEMPLATE.ETF_SOCIALIZE_BAD_DEBT_IN_VAULT_HUB(),
                    bytes.concat(
                        bytes20(vaultsAdapter),
                        bytes4(IVaultsAdapter.socializeBadDebt.selector)
                    )
                ))
            })
        });

        votingVoteItems[index++] = VoteItem({
            description: "11. Transfer 508,106 MATIC from Aragon Agent to Liquidity Observation Lab (LOL) Multisig 0x87D93d9B2C672bf9c9642d853a8682546a5012B5",
            call: ScriptCall({
                to: params.finance,
                data: abi.encodeCall(IFinance.newImmediatePayment, (
                    params.maticToken,
                    params.lolMultisig,
                    params.maticAmountWeiForTransfer,
                    params.transferReference
                ))
            })
        });

        assert(index == VOTING_ITEMS_COUNT);
    }

    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](DG_ITEMS_COUNT);
        uint256 index = 0;

        voteItems[index++] = VoteItem({
            description: "1.1. Check DG voting enactment is after December 4, 2025 00:00:00 UTC",
            call: ScriptCall({
                to: params.timeConstraints,
                data: abi.encodeCall(ITimeConstraints.checkTimeAfterTimestampAndEmit, (params.disabledBefore))
            })
        });

        voteItems[index++] = VoteItem({
            description: "1.2. Check DG voting enactment is before December 10, 2025 00:00:00 UTC",
            call: ScriptCall({
                to: params.timeConstraints,
                data: abi.encodeCall(ITimeConstraints.checkTimeBeforeTimestampAndEmit, (params.disabledAfter))
            })
        });

        voteItems[index++] = VoteItem({
            description: "1.3. Check DG voting enactment is within daily time window (14:00 UTC - 23:00 UTC)",
            call: ScriptCall({
                to: params.timeConstraints,
                data: abi.encodeCall(
                    ITimeConstraints.checkTimeWithinDayTimeAndEmit,
                    (
                        params.enabledDaySpanStart,
                        params.enabledDaySpanEnd
                    )
                )
            })
        });

        voteItems[index++] = VoteItem({
            description: "1.4. Call V3Template.startUpgrade",
            call: _forwardCall(TEMPLATE.AGENT(), params.upgradeTemplate, abi.encodeCall(V3Template.startUpgrade, ()))
        });

        voteItems[index++] = VoteItem({
            description: "1.5. Upgrade LidoLocator implementation",
            call: _forwardCall(TEMPLATE.AGENT(), TEMPLATE.LOCATOR(), abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (TEMPLATE.NEW_LOCATOR_IMPL())))
        });

        voteItems[index++] = VoteItem({
            description: "1.6. Grant Aragon APP_MANAGER_ROLE to the AGENT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACL(),
                abi.encodeWithSignature(
                    "grantPermission(address,address,bytes32)",
                    TEMPLATE.AGENT(),
                    TEMPLATE.KERNEL(),
                    keccak256("APP_MANAGER_ROLE")
                )
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.7. Set Lido implementation in Kernel",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.KERNEL(),
                abi.encodeCall(IKernel.setApp, (IKernel(TEMPLATE.KERNEL()).APP_BASES_NAMESPACE(), params.lidoAppId, TEMPLATE.NEW_LIDO_IMPL()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.8. Revoke Aragon APP_MANAGER_ROLE from the AGENT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACL(),
                abi.encodeWithSignature(
                    "revokePermission(address,address,bytes32)",
                    TEMPLATE.AGENT(),
                    TEMPLATE.KERNEL(),
                    keccak256("APP_MANAGER_ROLE")
                )
            )
        });

        bytes32 requestBurnSharesRole = IBurner(TEMPLATE.OLD_BURNER()).REQUEST_BURN_SHARES_ROLE();
        voteItems[index++] = VoteItem({
            description: "1.9. Revoke REQUEST_BURN_SHARES_ROLE from Lido",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.LIDO()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.10. Revoke REQUEST_BURN_SHARES_ROLE from Curated staking module",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.NODE_OPERATORS_REGISTRY()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.11. Revoke REQUEST_BURN_SHARES_ROLE from SimpleDVT",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.SIMPLE_DVT()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.12. Revoke REQUEST_BURN_SHARES_ROLE from Community Staking Accounting",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.OLD_BURNER(),
                abi.encodeCall(IAccessControl.revokeRole, (requestBurnSharesRole, TEMPLATE.CSM_ACCOUNTING()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.13. Upgrade AccountingOracle implementation",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ACCOUNTING_ORACLE(),
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (TEMPLATE.NEW_ACCOUNTING_ORACLE_IMPL()))
            )
        });

        bytes32 reportRewardsMintedRole = IStakingRouter(TEMPLATE.STAKING_ROUTER()).REPORT_REWARDS_MINTED_ROLE();
        voteItems[index++] = VoteItem({
            description: "1.14. Revoke REPORT_REWARDS_MINTED_ROLE from Lido",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.revokeRole, (reportRewardsMintedRole, TEMPLATE.LIDO()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.15. Grant REPORT_REWARDS_MINTED_ROLE to Accounting",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IAccessControl.grantRole, (reportRewardsMintedRole, TEMPLATE.ACCOUNTING()))
            )
        });

        bytes32 configManagerRole = IOracleDaemonConfig(TEMPLATE.ORACLE_DAEMON_CONFIG()).CONFIG_MANAGER_ROLE();

        voteItems[index++] = VoteItem({
            description: "1.16. Grant OracleDaemonConfig's CONFIG_MANAGER_ROLE to Agent",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IAccessControl.grantRole, (configManagerRole, TEMPLATE.AGENT()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.17. Set SLASHING_RESERVE_WE_RIGHT_SHIFT to 36 days at OracleDaemonConfig",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IOracleDaemonConfig.set, ("SLASHING_RESERVE_WE_RIGHT_SHIFT", abi.encode(params.odcSlashingReserveWeRightShiftEpochs)))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.18. Set SLASHING_RESERVE_WE_LEFT_SHIFT to 36 days at OracleDaemonConfig",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IOracleDaemonConfig.set, ("SLASHING_RESERVE_WE_LEFT_SHIFT", abi.encode(params.odcSlashingReserveWeLeftShiftEpochs)))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.19. Revoke OracleDaemonConfig's CONFIG_MANAGER_ROLE from Agent",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.ORACLE_DAEMON_CONFIG(),
                abi.encodeCall(IAccessControl.revokeRole, (configManagerRole, TEMPLATE.AGENT()))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.20. Call V3Template.finishUpgrade",
            call: _forwardCall(TEMPLATE.AGENT(), params.upgradeTemplate, abi.encodeCall(V3Template.finishUpgrade, ()))
        });

        IStakingRouter.StakingModule memory currentModule = IStakingRouter(TEMPLATE.STAKING_ROUTER()).getStakingModule(params.stakingModuleId);
        voteItems[index++] = VoteItem({
            description: "1.21. Raise SDVT (MODULE_ID = 2) stake share limit from 400 bps to 430 bps in Staking Router 0xFdDf38947aFB03C621C71b06C9C70bce73f12999",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                TEMPLATE.STAKING_ROUTER(),
                abi.encodeCall(IStakingRouter.updateStakingModule, (
                    params.stakingModuleId,
                    params.stakeShareLimit,
                    currentModule.priorityExitShareThreshold,
                    currentModule.stakingModuleFee,
                    currentModule.treasuryFee,
                    currentModule.maxDepositsPerBlock,
                    currentModule.minDepositBlockDistance
                ))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.22. Set spent amount for Easy Track TRP registry 0x231Ac69A1A37649C6B06a71Ab32DdD92158C80b8 to 0 LDO",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                params.easyTrackTrpRegistry,
                abi.encodeCall(IAllowedRecipientsRegistry.unsafeSetSpentAmount, (0))
            )
        });

        voteItems[index++] = VoteItem({
            description: "1.23. Set limit for Easy Track TRP registry 0x231Ac69A1A37649C6B06a71Ab32DdD92158C80b8 to 15'000'000 LDO with unchanged period duration of 12 months",
            call: _forwardCall(
                TEMPLATE.AGENT(),
                params.easyTrackTrpRegistry,
                abi.encodeCall(IAllowedRecipientsRegistry.setLimitParameters, (params.trpLimitAfter, params.trpPeriodDurationMonths))
            )
        });

        assert(index == DG_ITEMS_COUNT);
    }
}
