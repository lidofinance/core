// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/common/interfaces/IHashConsensus.sol";
import {ILido} from "contracts/common/interfaces/ILido.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {TierParams, OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {LazyOracle} from "contracts/0.8.25/vaults/LazyOracle.sol";
import {RefSlotCache, DoubleRefSlotCache, DOUBLE_CACHE_LENGTH} from "contracts/0.8.25/vaults/lib/RefSlotCache.sol";

import {StakingVaultsHandler} from "./StakingVaultsHandler.t.sol";
import {Constants} from "./StakingVaultConstants.sol";
import {PinnedBeaconProxyMock} from "./mocks/CommonMocks.sol";

contract StakingVaultsTest is Test {
    using RefSlotCache for RefSlotCache.Uint104WithCache;
    using DoubleRefSlotCache for DoubleRefSlotCache.Int104WithCache[DOUBLE_CACHE_LENGTH];

    VaultHub vaultHubProxy;
    StakingVault stakingVaultProxy;

    StakingVaultsHandler svHandler;

    address private rootAccount = makeAddr("rootAccount");
    address private userAccount = makeAddr("userAccount");

    address private treasury_addr = makeAddr("treasury");
    address private depositor = makeAddr("depositor");
    address private nodeOperator = makeAddr("nodeOperator");

    //contracts addresses
    address private pdg_addr = makeAddr("predepositGuarantee");
    address private accounting_addr = makeAddr("accounting");
    address private lazyOracle_addr = makeAddr("lazyoracle");
    address private operatorGrid_addr = makeAddr("operatorGrid");
    address private vaultHub_addr = makeAddr("vaultHub");
    address private lidoLocator_addr = makeAddr("lidoLocator");
    address private lido_addr = makeAddr("lido");
    address private consensusContract_addr = makeAddr("consensusContract");
    address private vaultFactory_addr = makeAddr("vaultFactory");

    function deployMockContracts() internal {
        //Deploy LidoMock
        deployCodeTo(
            "CommonMocks.sol:LidoMock",
            abi.encode(
                Constants.TOTAL_SHARES_MAINNET,
                Constants.TOTAL_POOLED_ETHER_MAINNET,
                Constants.EXTERNAL_SHARES_MAINNET
            ),
            lido_addr
        );

        //Deploy LazyOracleMock
        LazyOracle lazyOracle = new LazyOracle(lidoLocator_addr);

        vm.prank(rootAccount);
        deployCodeTo(
            "ERC1967Proxy",
            abi.encode(
                lazyOracle,
                abi.encodeWithSelector(
                    LazyOracle.initialize.selector,
                    rootAccount,
                    Constants.QUARANTINE_PERIOD,
                    Constants.MAX_REWARD_RATIO_BP,
                    Constants.MAX_LIDO_FEE_RATE_PER_SECOND
                )
            ),
            lazyOracle_addr
        );

        //Deploy ConsensusContractMock
        deployCodeTo("CommonMocks.sol:ConsensusContractMock", abi.encode(1, 0), consensusContract_addr);

        //Deploy VaultFactoryMock
        deployCodeTo("CommonMocks.sol:VaultFactoryMock", abi.encode(vaultFactory_addr), vaultFactory_addr);

        //Deploy PredepositGuaranteeMock
        deployCodeTo("CommonMocks.sol:PredepositGuaranteeMock", abi.encode(pdg_addr), pdg_addr);

        //Deploy LidoLocatorMock
        deployCodeTo(
            "CommonMocks.sol:LidoLocatorMock",
            abi.encode(
                lido_addr,
                pdg_addr,
                accounting_addr,
                treasury_addr,
                operatorGrid_addr,
                lazyOracle_addr,
                vaultHub_addr,
                consensusContract_addr,
                vaultFactory_addr
            ),
            lidoLocator_addr
        );
    }

    function deployOperatorGrid() internal {
        TierParams memory defaultTierParams = TierParams({
            shareLimit: Constants.SHARE_LIMIT,
            reserveRatioBP: Constants.RESERVE_RATIO_BP,
            forcedRebalanceThresholdBP: Constants.FORCED_REBALANCE_THRESHOLD_BP,
            infraFeeBP: Constants.INFRA_FEE_BP,
            liquidityFeeBP: Constants.LIQUIDITY_FEE_BP,
            reservationFeeBP: Constants.RESERVATION_FEE_BP
        });

        OperatorGrid operatorGrid = new OperatorGrid(ILidoLocator(address(lidoLocator_addr)));

        vm.prank(rootAccount);
        deployCodeTo(
            "ERC1967Proxy",
            abi.encode(
                operatorGrid,
                abi.encodeWithSelector(OperatorGrid.initialize.selector, rootAccount, defaultTierParams)
            ),
            operatorGrid_addr
        );
    }

    function deployVaultHub() internal {
        VaultHub vaultHub = new VaultHub(
            ILidoLocator(address(lidoLocator_addr)),
            ILido(address(lido_addr)),
            IHashConsensus(address(consensusContract_addr)),
            Constants.RELATIVE_SHARE_LIMIT
        );

        vm.prank(rootAccount);
        deployCodeTo(
            "ERC1967Proxy",
            abi.encode(vaultHub, abi.encodeWithSelector(VaultHub.initialize.selector, rootAccount)),
            vaultHub_addr
        );

        vaultHubProxy = VaultHub(payable(vaultHub_addr));

        bytes32 vaultMasterRole = vaultHubProxy.VAULT_MASTER_ROLE();
        vm.prank(rootAccount);
        vaultHubProxy.grantRole(vaultMasterRole, rootAccount);

        bytes32 validatorExitRole = vaultHubProxy.VALIDATOR_EXIT_ROLE();
        vm.prank(rootAccount);
        vaultHubProxy.grantRole(validatorExitRole, rootAccount);
    }

    function deployStakingVault() internal {
        //Create StakingVault contract
        StakingVault stakingVault = new StakingVault(address(0x22));

        PinnedBeaconProxyMock proxy = new PinnedBeaconProxyMock(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, userAccount, nodeOperator, pdg_addr, "0x")
        );
        stakingVaultProxy = StakingVault(payable(address(proxy)));
    }

    function setUp() public {
        //LidoMock
        //LidoLocatorMock
        //LazyOracleMock
        //ConsensusContractMock
        deployMockContracts();

        //VaultHub
        deployVaultHub();

        //OperatorGrid
        deployOperatorGrid();

        //StakingVault
        deployStakingVault();

        //Handler
        svHandler = new StakingVaultsHandler(lidoLocator_addr, address(stakingVaultProxy), rootAccount, userAccount);

        //We advance time to avoid a freshly connected vault to be able to mint shares
        //That would be possible because record.reportTimestamp (0 at connection) would be too close to block.timestamp (0 aswell) and considered fresh
        vm.warp(block.timestamp + 3 days);

        //First connect StakingVault to VaultHub
        svHandler.connectVault();

        // Configure fuzzing targets
        bytes4[] memory svSelectors = new bytes4[](14);
        svSelectors[0] = svHandler.fund.selector;
        svSelectors[1] = svHandler.VHwithdraw.selector;
        svSelectors[2] = svHandler.forceRebalance.selector;
        svSelectors[3] = svHandler.forceValidatorExit.selector;
        svSelectors[4] = svHandler.mintShares.selector;
        svSelectors[5] = svHandler.burnShares.selector;
        svSelectors[6] = svHandler.transferAndBurnShares.selector;
        svSelectors[7] = svHandler.voluntaryDisconnect.selector;
        svSelectors[8] = svHandler.sv_otcDeposit.selector;
        svSelectors[9] = svHandler.vh_otcDeposit.selector;
        svSelectors[10] = svHandler.updateVaultData.selector;
        svSelectors[11] = svHandler.SVwithdraw.selector;
        svSelectors[12] = svHandler.connectVault.selector;
        svSelectors[13] = svHandler.rebalance.selector;

        targetContract(address(svHandler));
        targetSelector(FuzzSelector({addr: address(svHandler), selectors: svSelectors}));
    }

    function test() public {
        svHandler.fund(1 ether);
        svHandler.updateVaultData(3);
        svHandler.voluntaryDisconnect();
    }

    ////////// INVARIANTS //////////

    //With current deployed environment (no slashing, no stETH rebase)
    //the staking Vault should never go below the rebalance threshold
    //Meaning having less locked collateral than the threshold ratio limit (in regards to the liabilityShares converted in ETH)
    //This is computed by rebalanceShortfall function

    // Invariant 1: Staking vault should never go below the rebalance threshold (collateral always covers liability).
    function invariant1_liabilityShares_not_above_collateral() external {
        uint256 rebalanceShares = vaultHubProxy.healthShortfallShares(address(stakingVaultProxy));
        assertEq(rebalanceShares, 0, "Staking Vault should never go below the rebalance threshold");
    }

    // Invariant 2: Dynamic total value (including deltas) should never underflow (must be >= 0).
    function invariant2_dynamic_totalValue_should_not_underflow() external {
        VaultHub.VaultRecord memory record = vaultHubProxy.vaultRecord(address(stakingVaultProxy));
        assertGe(
            int256(uint256(record.report.totalValue)) +
                int256(record.inOutDelta.currentValue()) -
                int256(record.report.inOutDelta),
            0,
            "Dynamic total value should not underflow"
        );
    }

    // Invariant 3: forceRebalance should not revert when the vault has available balance and obligations.
    function invariant3_forceRebalance_should_not_revert_when_has_available_balance_and_obligations() external {
        bool forceRebalanceReverted = svHandler.didForceRebalanceReverted();
        assertFalse(
            forceRebalanceReverted,
            "forceRebalance should not revert when has available balance and obligations"
        );
    }

    // Invariant 4: forceValidatorExit should not revert when has obligations shortfall.
    function invariant4_forceValidatorExit_should_not_revert_when_has_obligations_shortfall() external {
        bool forceValidatorExitReverted = svHandler.didForceValidatorExitReverted();
        assertFalse(forceValidatorExitReverted, "forceValidatorExit should not revert when has obligations shortfall");
    }

    // Invariant 5: Applied total value should not be greater than reported total value.
    function invariant5_applied_tv_should_not_be_greater_than_reported_tv() external {
        uint256 appliedTotalValue = svHandler.getAppliedTotalValue();
        uint256 reportedTotalValue = svHandler.getReportedTotalValue();

        assertLe(
            appliedTotalValue,
            reportedTotalValue,
            "Applied total value should not be greater than reported total value"
        );
    }

    // внимательно следить при каких операциях он держится (update connection, socilized bad dept)
    // Invariant 6: Liability shares should never be greater than connection share limit.
    function invariant6_liabilityshares_should_never_be_greater_than_connection_sharelimit() external {
        //Get the share limit from the vault
        uint256 liabilityShares = vaultHubProxy.liabilityShares(address(stakingVaultProxy));

        //Get the connection share limit from the vault
        VaultHub.VaultConnection memory connection = vaultHubProxy.vaultConnection(address(stakingVaultProxy));
        uint96 shareLimit = connection.shareLimit;
        assertLe(liabilityShares, shareLimit, "liability shares should never be greater than connection share limit");
    }

    modifier vaultMustBeConnected() {
        if (!vaultHubProxy.isVaultConnected(address(stakingVaultProxy))) {
            return;
        }
        _;
    }

    modifier vaultNotPendingDisconnect() {
        if (vaultHubProxy.isPendingDisconnect(address(stakingVaultProxy))) {
            return;
        }
        _;
    }

    // Invariant 7: Locked amount must be >= max(connect deposit, slashing reserve, reserve ratio).
    function invariant7_locked_cannot_be_less_than_slashing_connected_reserve()
        external
        vaultMustBeConnected
        vaultNotPendingDisconnect
    {
        //slashing reserve
        VaultHub.VaultRecord memory record = vaultHubProxy.vaultRecord(address(stakingVaultProxy));
        VaultHub.VaultConnection memory connection = vaultHubProxy.vaultConnection(address(stakingVaultProxy));
        uint256 forcedRebalanceThresholdBP = connection.forcedRebalanceThresholdBP;

        uint256 lockedAmount = vaultHubProxy.locked(address(stakingVaultProxy));
        uint256 liabilityStETH = ILido(address(lido_addr)).getPooledEthBySharesRoundUp(record.liabilityShares);

        uint256 minium_safety_buffer = (liabilityStETH * Constants.TOTAL_BASIS_POINTS) /
            (Constants.TOTAL_BASIS_POINTS - forcedRebalanceThresholdBP);

        assertGe(
            lockedAmount,
            Math256.max(Constants.CONNECT_DEPOSIT, minium_safety_buffer),
            "Locked amount should be greater than or equal to max(connect deposit, slashing reserve, reserve ratio)"
        );
    }

    // // function invariant_totalValue_should_be_greater_than_locked() vaultMustBeConnected vaultNotPendingDisconnect external {
    // //     //Get the total value of the vault
    // //     uint256 totalValue = vaultHubProxy.totalValue(address(stakingVaultProxy));
    // //     if (totalValue == 0) {
    // //         // If totalValue is 0, we cannot check the invariant
    // //         //That's probably because the vault has just been created and no report has not been applied yet
    // //         return;
    // //     }

    // //     //Get the locked amount
    // //     VaultHub.VaultRecord memory record = vaultHubProxy.vaultRecord(address(stakingVaultProxy));
    // //     uint128 lockedAmount = record.locked;

    // //     //VaultHub.VaultObligations memory vaultObligations = vaultHubProxy.vaultObligations(address(stakingVaultProxy));
    // //     //uint256 unsettledObligations = vaultObligations.unsettledLidoFees + vaultObligations.redemptions;

    // //     //Check that total value is greater than or equal to locked amount and unsettled obligations
    // //     assertGe(totalValue, lockedAmount , "Total value should be greater than or equal to locked amount");
    // // }

    // Invariant 8: Withdrawable value must be <= total value minus locked amount and unsettled obligations.
    function invariant8_withdrawableValue_should_be_less_than_or_equal_to_totalValue_minus_locked_and_obligations()
        external
    {
        //Get the withdrawable value of the vault
        uint256 withdrawableValue = vaultHubProxy.withdrawableValue(address(stakingVaultProxy));

        //Get the total value of the vault
        uint256 totalValue = vaultHubProxy.totalValue(address(stakingVaultProxy));

        //Get the locked amount and unsettled obligations
        uint256 lockedAmount = vaultHubProxy.locked(address(stakingVaultProxy));
        (uint256 obligationsShares, uint256 obligationsFees) = vaultHubProxy.obligations(address(stakingVaultProxy));

        uint256 unsettled_plus_locked = obligationsFees + lockedAmount;
        uint256 tv_minus_locked_and_obligations = totalValue > unsettled_plus_locked
            ? totalValue - unsettled_plus_locked
            : 0;

        assertLe(
            withdrawableValue,
            tv_minus_locked_and_obligations,
            "Withdrawable value should be less than or equal to total value minus locked amount and unsettled obligations"
        );
    }

    //The totalValue should be equal or above the real totalValue (EL+CL balance)
    //totalValue = report.totalValue + current ioDelta - reported ioDelta
    //This invariant catches the crit vulnerability that exploits
    //- replay of same report
    //- uncleared quarantine upon disconnect
    //call path is pretty long but is:
    //1. connectVault
    //2. sv_otcDeposit
    //3. updateVaultData -> triggers quarantine
    //4. initializeDisconnect
    //5. updateVaultData -> finalize disconnection
    //6. connectVault
    //7. updateVaultData -> generate a fresh report with TV
    //8. SVwithdraw
    //9. connectVault
    //10. updateVaultData -> reuses previous report; quarantine is expired; TV is kept as is (special branch if the new quarantine delta is lower than the expired one).
    // Invariant 9: Computed totalValue must be <= effective (real) total value.
    // function invariant9_computed_totalValue_must_be_less_than_or_equal_to_effective_total_value() external {
    //     assertLe(svHandler.getVaultTotalValue(), svHandler.getEffectiveVaultTotalValue());
    // }

    // For testing purposes only (guiding the fuzzing)
    // function invariant_state() external {
    //     assertEq(svHandler.actionIndex() != 11, true, "callpath reached");
    // }
}
