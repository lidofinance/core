// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/0.8.25/vaults/interfaces/IHashConsensus.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";

import {MultiStakingVaultHandler} from "./MultiStakingVaultHandler.t.sol";
import {Constants} from "./StakingVaultConstants.sol";

import {LazyOracleMock} from "./mocks/LazyOracleMock.sol";
import {OperatorGridMock, TierParams} from "./mocks/OperatorGridMock.sol";

import {Math256} from "contracts/common/lib/Math256.sol";

contract MultiStakingVaultsTest is Test {
    VaultHub vaultHubProxy;
    StakingVault[] stakingVaultProxies;

    OperatorGridMock operatorGridProxy;

    //uint256[2] groupShareLimit = [1000 ether, 500 ether];
    uint256[2] groupShareLimit = [1000, 500];
    MultiStakingVaultHandler msvHandler;

    address private rootAccount = makeAddr("rootAccount");
    address[2] private nodeOpAccount = [makeAddr("nodeOpAccount1"), makeAddr("nodeOpAccount2")];
    address[] private userAccount;

    uint256 private constant NB_VAULTS = 5;

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
        deployCodeTo(
            "CommonMocks.sol:LazyOracleMock",
            abi.encode(
                lidoLocator_addr,
                consensusContract_addr,
                Constants.QUARANTINE_PERIOD,
                Constants.MAX_REWARD_RATIO_BP
            ),
            lazyOracle_addr
        );

        //Deploy ConsensusContractMock
        deployCodeTo("CommonMocks.sol:ConsensusContractMock", abi.encode(1, 0), consensusContract_addr);

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
                consensusContract_addr
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

        //Deploy OperatorGridMock
        OperatorGridMock operatorGrid = new OperatorGridMock(ILidoLocator(address(lidoLocator_addr)));

        vm.prank(rootAccount);
        deployCodeTo(
            "ERC1967Proxy",
            abi.encode(
                operatorGrid,
                abi.encodeWithSelector(OperatorGridMock.initialize.selector, rootAccount, defaultTierParams)
            ),
            operatorGrid_addr
        );

        //register 2 Groups
        operatorGridProxy = OperatorGridMock(payable(operatorGrid_addr));

        //grantRole REGISTRY_ROLE
        vm.startPrank(rootAccount);
        bytes32 operatorGridRegistryRole = operatorGridProxy.REGISTRY_ROLE();
        operatorGridProxy.grantRole(
            operatorGridRegistryRole,
            rootAccount
        );

        operatorGridProxy.registerGroup(
            nodeOpAccount[0],
            groupShareLimit[0]
        );
        operatorGridProxy.registerGroup(
            nodeOpAccount[1],
            groupShareLimit[1]
        );

        
        TierParams[] memory tiersParamsGroup1 = new TierParams[](2);
        TierParams[] memory tiersParamsGroup2 = new TierParams[](2);

        tiersParamsGroup1[0] = TierParams({
            shareLimit: Constants.SHARE_LIMIT,
            reserveRatioBP: Constants.RESERVE_RATIO_BP,
            forcedRebalanceThresholdBP: Constants.FORCED_REBALANCE_THRESHOLD_BP,
            infraFeeBP: Constants.INFRA_FEE_BP,
            liquidityFeeBP: Constants.LIQUIDITY_FEE_BP,
            reservationFeeBP: Constants.RESERVATION_FEE_BP
        });

        tiersParamsGroup1[1] = TierParams({
            shareLimit: Constants.SHARE_LIMIT + 1,
            reserveRatioBP: Constants.RESERVE_RATIO_BP + 1,
            forcedRebalanceThresholdBP: Constants.FORCED_REBALANCE_THRESHOLD_BP + 1,
            infraFeeBP: Constants.INFRA_FEE_BP + 1,
            liquidityFeeBP: Constants.LIQUIDITY_FEE_BP + 1,
            reservationFeeBP: Constants.RESERVATION_FEE_BP + 1
        });

        tiersParamsGroup2[0] = TierParams({
            shareLimit: Constants.SHARE_LIMIT + 2,
            reserveRatioBP: Constants.RESERVE_RATIO_BP + 2,
            forcedRebalanceThresholdBP: Constants.FORCED_REBALANCE_THRESHOLD_BP + 2,
            infraFeeBP: Constants.INFRA_FEE_BP + 2,
            liquidityFeeBP: Constants.LIQUIDITY_FEE_BP + 2,
            reservationFeeBP: Constants.RESERVATION_FEE_BP + 2
        });

        tiersParamsGroup2[1] = TierParams({
            shareLimit: Constants.SHARE_LIMIT + 3,
            reserveRatioBP: Constants.RESERVE_RATIO_BP + 3,
            forcedRebalanceThresholdBP: Constants.FORCED_REBALANCE_THRESHOLD_BP + 3,
            infraFeeBP: Constants.INFRA_FEE_BP + 3,
            liquidityFeeBP: Constants.LIQUIDITY_FEE_BP + 3,
            reservationFeeBP: Constants.RESERVATION_FEE_BP + 3
        });

        //register Tiers1,2 from Group1 and Tiers3,4 from Group2
        operatorGridProxy.registerTiers(
            nodeOpAccount[0],
            tiersParamsGroup1
        );

        operatorGridProxy.registerTiers(
            nodeOpAccount[1],
            tiersParamsGroup2
        );
        vm.stopPrank();
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

        bytes32 vaultCodehashSetRole = vaultHubProxy.VAULT_CODEHASH_SET_ROLE();
        vm.prank(rootAccount);
        vaultHubProxy.grantRole(vaultCodehashSetRole, rootAccount);
    }

    function deployStakingVaults() internal {
        for (uint256 i=0; i<userAccount.length; i++) {
            vm.startPrank(userAccount[i]);
            StakingVault stakingVault = new StakingVault(address(0x22));
            ERC1967Proxy proxy = new ERC1967Proxy(
                address(stakingVault),
                abi.encodeWithSelector(StakingVault.initialize.selector, userAccount[i], nodeOpAccount[i%2], pdg_addr, "0x")
            );
            stakingVaultProxies.push(StakingVault(payable(address(proxy))));
        }
        vm.stopPrank();
        vm.prank(rootAccount);
        vaultHubProxy.setAllowedCodehash(address(stakingVaultProxies[0]).codehash, true);
    }

    function setUp() public {
        //Creating userAccounts (staking vault admins)
        uint256 addr_seed = uint256(keccak256(abi.encodePacked("userAccount")));
        for (uint256 i; i < NB_VAULTS; i++){
            userAccount.push(vm.addr(addr_seed+i));
        }

        //LidoMock
        //LidoLocatorMock
        //ConsensusContractMock
        deployMockContracts();

        //VaultHub
        deployVaultHub();

        //OperatorGrid
        deployOperatorGrid();

        //StakingVaults
        deployStakingVaults();

        //Handler
        msvHandler = new MultiStakingVaultHandler(lidoLocator_addr, stakingVaultProxies, rootAccount, userAccount);

        //We advance time to avoid a freshly connected vault to be able to mint shares
        //That would be possible because record.reportTimestamp (0 at connection) would be too close to block.timestamp (0 aswell) and considered fresh
        vm.warp(block.timestamp + 3 days); 
        console2.log(userAccount.length);
        //First connect StakingVault to VaultHub
        for (uint256 i=0; i<userAccount.length; i++) {
            msvHandler.connectVault(i);
        }


        // Configure fuzzing targets
        bytes4[] memory svSelectors = new bytes4[](12);
        svSelectors[0] = msvHandler.connectVault.selector;
        svSelectors[1] = msvHandler.voluntaryDisconnect.selector;
        svSelectors[2] = msvHandler.fund.selector;
        svSelectors[3] = msvHandler.VHwithdraw.selector;
        svSelectors[4] = msvHandler.forceRebalance.selector;
        svSelectors[5] = msvHandler.forceValidatorExit.selector;
        svSelectors[6] = msvHandler.mintShares.selector;
        svSelectors[7] = msvHandler.burnShares.selector;
        svSelectors[8] = msvHandler.sv_otcDeposit.selector;
        svSelectors[9] = msvHandler.vh_otcDeposit.selector;
        svSelectors[9] = msvHandler.updateVaultData.selector;
        svSelectors[10] = msvHandler.SVwithdraw.selector;
        svSelectors[11] = msvHandler.changeTier.selector;
        

        targetContract(address(msvHandler));
        targetSelector(FuzzSelector({addr: address(msvHandler), selectors: svSelectors}));
    }

    ////////// INVARIANTS //////////

    //Helper get all vaults in a tier
    function get_all_vaults_in_tier(uint256 tierId) internal returns (address[] memory) {
        address[] memory tempVaults = new address[](stakingVaultProxies.length);
        uint256 count = 0;
        for (uint256 i = 0; i < stakingVaultProxies.length; i++) {
            (,uint256 vaultTierId,,,,,,) = operatorGridProxy.vaultInfo(address(stakingVaultProxies[i]));
            if (vaultTierId == tierId) {
                tempVaults[count++] = address(stakingVaultProxies[i]);
            }
        }
        // Resize the array to the actual count
        address[] memory vaults = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            vaults[i] = tempVaults[i];
        }
        return vaults;
    }


    // Invariant 1: No Vault Exceeds Its Own Share Limit
    function invariant1_vault_liability_below_share_limit() external {
        for (uint256 i = 0; i < stakingVaultProxies.length; i++) {
            address vault = address(stakingVaultProxies[i]);
            uint256 shareLimit = vaultHubProxy.vaultConnection(vault).shareLimit;
            uint256 liability = vaultHubProxy.liabilityShares(vault);
            assertLe(liability, shareLimit, "Vault liabilityShares must not exceed its shareLimit");
        }
    }

    // Invariant 2: Sum of all tier liabilityShares in a group <= group's shareLimit
    function invariant2_group_tier_liabilities_below_group_limit() external {
        for (uint256 i = 0; i < nodeOpAccount.length; i++) {
            OperatorGridMock.Group memory group = operatorGridProxy.group(nodeOpAccount[i]);
            uint256 sumTierLiabilities = 0;
            for (uint256 j = 0; j < group.tierIds.length; j++) {
                OperatorGridMock.Tier memory tier = operatorGridProxy.tier(group.tierIds[j]);
                sumTierLiabilities += tier.liabilityShares;
            }
            assertLe(sumTierLiabilities, group.shareLimit, "Sum of tier liabilityShares in a group must not exceed group's shareLimit");
        }
    }

    // Invariant 3: Sum of vaults' liabilityShares in a tier == tier's liabilityShares
    function invariant3_tier_liability_consistency() external {
        for (uint256 i = 0; i < operatorGridProxy.tiersCount(); i++) {
            OperatorGridMock.Tier memory tier = operatorGridProxy.tier(i);
            address[] memory vaults = get_all_vaults_in_tier(i);
            uint256 sumVaultLiabilities = 0;
            for (uint256 j = 0; j < vaults.length; j++) {
                sumVaultLiabilities += vaultHubProxy.liabilityShares(vaults[j]);
            }
            assertEq(sumVaultLiabilities, tier.liabilityShares, "Sum of vaults' liabilityShares in a tier must equal tier's liabilityShares");
        }
    }

    // Invariant 4: Sum of vaults' liabilityShares in the default tier <= default tier shareLimit
    function invariant4_default_tier_liability_consistency() external {
        address[] memory vaults = get_all_vaults_in_tier(Constants.DEFAULT_TIER);
        OperatorGridMock.Tier memory default_tier = operatorGridProxy.tier(Constants.DEFAULT_TIER);
        uint256 sumVaultLiabilities = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            sumVaultLiabilities += vaultHubProxy.liabilityShares(vaults[i]);
        }
        assertLe(sumVaultLiabilities, default_tier.shareLimit, "Sum of vaults' liabilityShares in the default tier must be less than or equal to the default tier's shareLimit");
    }


    // Invariant 5: Vault's connection settings must match their current Tier info
    function invariant5_vault_connection_info() external {
        for (uint256 i = 0; i < stakingVaultProxies.length; i++) {
            address vault = address(stakingVaultProxies[i]);
            VaultHub.VaultConnection memory vc = vaultHubProxy.vaultConnection(vault);

            if (vc.vaultIndex == 0) return;

            (
                ,
                ,
                uint256 shareLimit,
                uint256 reserveRatioBP,
                uint256 forcedRebalanceThresholdBP,
                uint256 infraFeeBP,
                uint256 liquidityFeeBP,
                uint256 reservationFeeBP
            ) = operatorGridProxy.vaultInfo(vault);
            assertEq(vc.shareLimit, shareLimit, "Vault's shareLimit in connection must match OperatorGrid registered VaultInfo");
            assertEq(vc.reserveRatioBP, reserveRatioBP, "Vault's reserveRatioBP in connection must match OperatorGrid registered VaultInfo");
            assertEq(vc.forcedRebalanceThresholdBP, forcedRebalanceThresholdBP, "Vault's forcedRebalanceThresholdBP in connection must match OperatorGrid registered VaultInfo");
            assertEq(vc.infraFeeBP, infraFeeBP, "Vault's infraFeeBP in connection must match OperatorGrid registered VaultInfo");
            assertEq(vc.liquidityFeeBP, liquidityFeeBP, "Vault's liquidityFeeBP in connection must match OperatorGrid registered VaultInfo");
            assertEq(vc.reservationFeeBP, reservationFeeBP, "Vault's reservationFeeBP in connection must match OperatorGrid registered VaultInfo");
        }
    }

}
