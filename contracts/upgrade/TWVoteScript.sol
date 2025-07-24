// SPDX-License-Identifier: GPL-3.0
pragma solidity 0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/IAccessControl.sol";
import {OmnibusBase} from "./utils/OmnibusBase.sol";

interface IOssifiableProxy {
    function proxy__upgradeTo(address newImplementation_) external;
    function proxy__changeAdmin(address newAdmin_) external;
    function proxy__getAdmin() external view returns (address);
    function proxy__getImplementation() external view returns (address);
}

interface IRepo {
    function newVersion(uint16[3] calldata _newSemanticVersion, address _contractAddress, bytes calldata _contentURI) external;
}

interface IKernel {
    function setApp(bytes32 _namespace, bytes32 _appId, address _app) external;
    function APP_BASES_NAMESPACE() external view returns (bytes32);
}

interface IWithdrawalVaultProxy {
    function proxy_upgradeTo(address _implementation, bytes calldata _data) external;
    function proxy_getAdmin() external view returns (address);
}

interface IOracleContract {
    function setConsensusVersion(uint256 _version) external;
    function finalizeUpgrade_v2(uint256 _maxValidatorsPerReport, uint256 _maxExitRequestsLimit, uint256 _exitsPerFrame, uint256 _frameDurationInSec) external;
}

interface IWithdrawalVault {
    function finalizeUpgrade_v2() external;
}

interface INodeOperatorsRegistry {
    function finalizeUpgrade_v4(uint256 _exitDeadlineThresholdInSeconds) external;
}

interface IOracleDaemonConfig {
    function set(string calldata _key, bytes calldata _value) external;
    function unset(string calldata _key) external;
}

/// @title TWVoteScript
/// @notice Script for implementing Triggerable Withdrawals voting items
contract TWVoteScript is OmnibusBase {
    address public constant MAINNET_ACL = 0x9895F0F17cc1d1891b6f18ee0b483B6f221b37Bb;
    address public constant MAINNET_KERNEL = 0xb8FFC3Cd6e7Cf5a098A1c92F48009765B24088Dc;

    struct ScriptParams {
        // Contract addresses
        address agent;
        address lido_locator;
        address lido_locator_impl;
        address validators_exit_bus_oracle;
        address validators_exit_bus_oracle_impl;
        address triggerable_withdrawals_gateway;
        address withdrawal_vault;
        address withdrawal_vault_impl;
        address accounting_oracle;
        address accounting_oracle_impl;
        address staking_router;
        address staking_router_impl;
        address validator_exit_verifier;
        address node_operators_registry;
        address node_operators_registry_impl;
        address simple_dvt;
        address oracle_daemon_config;

        // Other parameters
        bytes32 node_operators_registry_app_id;
        bytes32 simple_dvt_app_id;
        uint16[3] nor_version;
        uint256 vebo_consensus_version;
        uint256 ao_consensus_version;
        uint256 nor_exit_deadline_in_sec;
        uint256 exit_events_lookback_window_in_slots;
        bytes nor_content_uri;
    }

    //
    // Constants
    //
    uint256 public constant VOTE_ITEMS_COUNT = 24;

    //
    // Structured storage
    //
    ScriptParams public params;

    constructor(address _voting, address _dualGovernance, ScriptParams memory _params) OmnibusBase(_voting, _dualGovernance) {
        params = _params;
    }

    function getVoteItems() public view override returns (VoteItem[] memory voteItems) {
        voteItems = new VoteItem[](VOTE_ITEMS_COUNT);
        uint256 index = 0;

        // 1. Update locator implementation
        voteItems[index++] = VoteItem({
            description: "1. Update locator implementation",
            call: _forwardCall(
                params.agent,
                params.lido_locator,
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (params.lido_locator_impl))
            )
        });

        // 2. Update VEBO implementation
        voteItems[index++] = VoteItem({
            description: "2. Update VEBO implementation",
            call: _forwardCall(
                params.agent,
                params.validators_exit_bus_oracle,
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (params.validators_exit_bus_oracle_impl))
            )
        });

        // 3. Call finalizeUpgrade_v2 on VEBO
        voteItems[index++] = VoteItem({
            description: "3. Call finalizeUpgrade_v2 on VEBO",
            call: _forwardCall(
                params.agent,
                params.validators_exit_bus_oracle,
                abi.encodeCall(IOracleContract.finalizeUpgrade_v2, (600, 13000, 1, 48))
            )
        });

        // 4. Grant VEBO role MANAGE_CONSENSUS_VERSION_ROLE to the AGENT
        bytes32 manageConsensusVersionRole = keccak256("MANAGE_CONSENSUS_VERSION_ROLE");
        voteItems[index++] = VoteItem({
            description: "4. Grant VEBO role MANAGE_CONSENSUS_VERSION_ROLE to the AGENT",
            call: _forwardCall(
                params.agent,
                params.validators_exit_bus_oracle,
                abi.encodeCall(IAccessControl.grantRole, (manageConsensusVersionRole, params.agent))
            )
        });

        // 5. Bump VEBO consensus version
        voteItems[index++] = VoteItem({
            description: "5. Bump VEBO consensus version",
            call: _forwardCall(
                params.agent,
                params.validators_exit_bus_oracle,
                abi.encodeCall(IOracleContract.setConsensusVersion, (params.vebo_consensus_version))
            )
        });

        // 6. Grant TWG role ADD_FULL_WITHDRAWAL_REQUEST_ROLE to the VEB
        bytes32 addFullWithdrawalRequestRole = keccak256("ADD_FULL_WITHDRAWAL_REQUEST_ROLE");
        voteItems[index++] = VoteItem({
            description: "6. Grant TWG role ADD_FULL_WITHDRAWAL_REQUEST_ROLE to the VEB",
            call: _forwardCall(
                params.agent,
                params.triggerable_withdrawals_gateway,
                abi.encodeCall(IAccessControl.grantRole, (addFullWithdrawalRequestRole, params.validators_exit_bus_oracle))
            )
        });

        // 7. Update WithdrawalVault implementation
        voteItems[index++] = VoteItem({
            description: "7. Update WithdrawalVault implementation",
            call: _forwardCall(
                params.agent,
                params.withdrawal_vault,
                abi.encodeCall(IWithdrawalVaultProxy.proxy_upgradeTo, (params.withdrawal_vault_impl, ""))
            )
        });

        // 8. Call finalizeUpgrade_v2 on WithdrawalVault
        voteItems[index++] = VoteItem({
            description: "8. Call finalizeUpgrade_v2 on WithdrawalVault",
            call: _forwardCall(
                params.agent,
                params.withdrawal_vault,
                abi.encodeCall(IWithdrawalVault.finalizeUpgrade_v2, ())
            )
        });

        // 9. Update Accounting Oracle implementation
        voteItems[index++] = VoteItem({
            description: "9. Update Accounting Oracle implementation",
            call: _forwardCall(
                params.agent,
                params.accounting_oracle,
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (params.accounting_oracle_impl))
            )
        });

        // 10. Grant AO MANAGE_CONSENSUS_VERSION_ROLE to the AGENT
        voteItems[index++] = VoteItem({
            description: "10. Grant AO MANAGE_CONSENSUS_VERSION_ROLE to the AGENT",
            call: _forwardCall(
                params.agent,
                params.accounting_oracle,
                abi.encodeCall(IAccessControl.grantRole, (manageConsensusVersionRole, params.agent))
            )
        });

        // 11. Bump AO consensus version
        voteItems[index++] = VoteItem({
            description: "11. Bump AO consensus version",
            call: _forwardCall(
                params.agent,
                params.accounting_oracle,
                abi.encodeCall(IOracleContract.setConsensusVersion, (params.ao_consensus_version))
            )
        });

        // 12. Update SR implementation
        voteItems[index++] = VoteItem({
            description: "12. Update SR implementation",
            call: _forwardCall(
                params.agent,
                params.staking_router,
                abi.encodeCall(IOssifiableProxy.proxy__upgradeTo, (params.staking_router_impl))
            )
        });

        // 13. Grant SR role REPORT_VALIDATOR_EXITING_STATUS_ROLE to ValidatorExitVerifier
        bytes32 reportValidatorExitingStatusRole = keccak256("REPORT_VALIDATOR_EXITING_STATUS_ROLE");
        voteItems[index++] = VoteItem({
            description: "13. Grant SR role REPORT_VALIDATOR_EXITING_STATUS_ROLE to ValidatorExitVerifier",
            call: _forwardCall(
                params.agent,
                params.staking_router,
                abi.encodeCall(IAccessControl.grantRole, (reportValidatorExitingStatusRole, params.validator_exit_verifier))
            )
        });

        // 14. Grant SR role REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE to TWG
        bytes32 reportValidatorExitTriggeredRole = keccak256("REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE");
        voteItems[index++] = VoteItem({
            description: "14. Grant SR role REPORT_VALIDATOR_EXIT_TRIGGERED_ROLE to TWG",
            call: _forwardCall(
                params.agent,
                params.staking_router,
                abi.encodeCall(IAccessControl.grantRole, (reportValidatorExitTriggeredRole, params.triggerable_withdrawals_gateway))
            )
        });

        // 15. Add APP_MANAGER_ROLE to the AGENT
        voteItems[index++] = VoteItem({
            description: "15. Add APP_MANAGER_ROLE to the AGENT",
            call: _forwardCall(
                params.agent,
                MAINNET_ACL,
                abi.encodeWithSignature(
                    "grantPermission(address,address,bytes32)",
                    params.agent,
                    MAINNET_KERNEL,
                    keccak256("APP_MANAGER_ROLE")
                )
            )
        });

        // 16. Update NodeOperatorsRegistry implementation
        voteItems[index++] = VoteItem({
            description: "16. Update NodeOperatorsRegistry implementation",
            call: _forwardCall(
                params.agent,
                MAINNET_KERNEL,
                abi.encodeWithSignature("setApp(bytes32,bytes32,address)",
                    IKernel(MAINNET_KERNEL).APP_BASES_NAMESPACE(),
                    params.node_operators_registry_app_id,
                    params.node_operators_registry_impl
                )
            )
        });

        // 17. Call finalizeUpgrade_v4 on NOR
        voteItems[index++] = VoteItem({
            description: "19. Call finalizeUpgrade_v4 on NOR",
            call: _forwardCall(
                params.agent,
                params.node_operators_registry,
                abi.encodeCall(INodeOperatorsRegistry.finalizeUpgrade_v4, (params.nor_exit_deadline_in_sec))
            )
        });

        // 18. Update SimpleDVT implementation
        voteItems[index++] = VoteItem({
            description: "18. Update SimpleDVT implementation",
            call: _forwardCall(
                params.agent,
                MAINNET_KERNEL,
                abi.encodeWithSignature("setApp(bytes32,bytes32,address)",
                    IKernel(MAINNET_KERNEL).APP_BASES_NAMESPACE(),
                    params.simple_dvt_app_id,
                    params.node_operators_registry_impl
                )
            )
        });

        // 19. Call finalizeUpgrade_v4 on SimpleDVT
        voteItems[index++] = VoteItem({
            description: "20. Call finalizeUpgrade_v4 on SimpleDVT",
            call: _forwardCall(
                params.agent,
                params.simple_dvt,
                abi.encodeCall(INodeOperatorsRegistry.finalizeUpgrade_v4, (params.nor_exit_deadline_in_sec))
            )
        });

        // 20. Grant CONFIG_MANAGER_ROLE role to the AGENT
        bytes32 configManagerRole = keccak256("CONFIG_MANAGER_ROLE");
        voteItems[index++] = VoteItem({
            description: "21. Grant CONFIG_MANAGER_ROLE role to the AGENT",
            call: _forwardCall(
                params.agent,
                params.oracle_daemon_config,
                abi.encodeCall(IAccessControl.grantRole, (configManagerRole, params.agent))
            )
        });

        // 21. Remove NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP variable from OracleDaemonConfig
        voteItems[index++] = VoteItem({
            description: "22. Remove NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP variable from OracleDaemonConfig",
            call: _forwardCall(
                params.agent,
                params.oracle_daemon_config,
                abi.encodeCall(IOracleDaemonConfig.unset, ("NODE_OPERATOR_NETWORK_PENETRATION_THRESHOLD_BP"))
            )
        });

        // 22. Remove VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS variable from OracleDaemonConfig
        voteItems[index++] = VoteItem({
            description: "23. Remove VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS variable from OracleDaemonConfig",
            call: _forwardCall(
                params.agent,
                params.oracle_daemon_config,
                abi.encodeCall(IOracleDaemonConfig.unset, ("VALIDATOR_DELAYED_TIMEOUT_IN_SLOTS"))
            )
        });

        // 23. Remove VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS variable from OracleDaemonConfig
        voteItems[index++] = VoteItem({
            description: "24. Remove VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS variable from OracleDaemonConfig",
            call: _forwardCall(
                params.agent,
                params.oracle_daemon_config,
                abi.encodeCall(IOracleDaemonConfig.unset, ("VALIDATOR_DELINQUENT_TIMEOUT_IN_SLOTS"))
            )
        });

        // 24. Add EXIT_EVENTS_LOOKBACK_WINDOW_IN_SLOTS variable to OracleDaemonConfig
        voteItems[index++] = VoteItem({
            description: "25. Add EXIT_EVENTS_LOOKBACK_WINDOW_IN_SLOTS variable to OracleDaemonConfig",
            call: _forwardCall(
                params.agent,
                params.oracle_daemon_config,
                abi.encodeCall(IOracleDaemonConfig.set, ("EXIT_EVENTS_LOOKBACK_WINDOW_IN_SLOTS", abi.encode(params.exit_events_lookback_window_in_slots)))
            )
        });

        assert(index == VOTE_ITEMS_COUNT);
    }

    // Debug helper function
    function getDebugParams() external view returns (
        address agent,
        address lido_locator,
        address validators_exit_bus_oracle,
        address withdrawal_vault,
        bytes32 node_operators_registry_app_id
    ) {
        return (
            params.agent,
            params.lido_locator,
            params.validators_exit_bus_oracle,
            params.withdrawal_vault,
            params.node_operators_registry_app_id
        );
    }
}