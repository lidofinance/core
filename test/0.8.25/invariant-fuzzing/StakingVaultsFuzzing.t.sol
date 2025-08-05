// SPDX-License-Identifier: UNLICENSED

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {TierParams, OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {IHashConsensus} from "contracts/0.8.25/vaults/interfaces/IHashConsensus.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";

import {StakingVaultsHandler} from "./StakingVaultsHandler.t.sol";
import {Constants} from "./StakingVaultConstants.sol";

import {LazyOracleMock} from "./CommonMocks.sol";

contract StakingVaultsTest is Test {
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

        bytes32 vaultCodehashSetRole = vaultHubProxy.VAULT_CODEHASH_SET_ROLE();
        vm.prank(rootAccount);
        vaultHubProxy.grantRole(vaultCodehashSetRole, rootAccount);
    }

    function deployStakingVault() internal {
        //Create StakingVault contract
        StakingVault stakingVault = new StakingVault(address(0x22));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, userAccount, nodeOperator, pdg_addr, "0x")
        );
        stakingVaultProxy = StakingVault(payable(address(proxy)));

        vm.prank(rootAccount);
        //Allow the stakingVault contract to be connected
        vaultHubProxy.setAllowedCodehash(address(stakingVaultProxy).codehash, true);
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

        //First connect StakingVault to VaultHub
        svHandler.connectVault();

        // Configure fuzzing targets
        bytes4[] memory svSelectors = new bytes4[](11);
        svSelectors[0] = svHandler.fund.selector;
        svSelectors[1] = svHandler.VHwithdraw.selector;
        svSelectors[2] = svHandler.rebalance.selector;
        svSelectors[3] = svHandler.mintShares.selector;
        svSelectors[4] = svHandler.burnShares.selector;
        svSelectors[5] = svHandler.transferAndBurnShares.selector;
        svSelectors[6] = svHandler.voluntaryDisconnect.selector;
        svSelectors[7] = svHandler.otcDeposit.selector;
        svSelectors[8] = svHandler.updateVaultData.selector;
        svSelectors[9] = svHandler.SVwithdraw.selector;
        svSelectors[10] = svHandler.connectVault.selector;

        targetContract(address(svHandler));
        targetSelector(FuzzSelector({addr: address(svHandler), selectors: svSelectors}));
    }

    ////////// INVARIANTS //////////

    /*
    Ideas of invariants to implement:
    - locked amount should always above reserve ratio in regards to the liabilityShares of the SV
    //liabilityShare should not be upper to collateral
    // function invariant_liabilityShares_not_above_collateral() external {
    //     assertGt(svHandler.getVaultTotalValue(),svHandler.getEffectiveVaultTotalValue());
    // }

    */

    //The totalValue should be equal or above the real totalValue (EL+CL balance)
    //totalValue = report.totalValue + current ioDelta - reported ioDelta
    //This invariant catches the crit vulnerability that exploits
    //- replay of same report
    //- uncleared quarantine upon disconnect
    //call path is pretty long but is:
    //1. connectVault
    //2. otcDeposit
    //3. updateVaultData -> triggers quarantine
    //4. initializeDisconnect
    //5. updateVaultData -> finalize disconnection
    //6. connectVault
    //7. updateVaultData -> generate a fresh report with TV
    //8. SVwithdraw
    //9. connectVault
    //10. updateVaultData -> reuses previous report; quarantine is expired; TV is kept as is (special branch if the new quarantine delta is lower than the expired one).
    function invariant_check_totalValue() external {
        assertLe(svHandler.getVaultTotalValue(), svHandler.getEffectiveVaultTotalValue());
    }

    /*
   //for testing purposes only (guiding the fuzzing)
    function invariant_state() external {
        assertEq(svHandler.actionIndex() != 11, true, "callpath reached");
    }
*/
}
