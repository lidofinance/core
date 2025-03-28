// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {StdCheats} from "forge-std/StdCheats.sol";

import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";
import {LimitsList} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

import {StakingRouter__MockForLidoAccountingFuzzing} from "./contracts/StakingRouter__MockForLidoAccountingFuzzing.sol";
import {SecondOpinionOracle__MockForAccountingFuzzing} from "./contracts/SecondOpinionOracle__MockForAccountingFuzzing.sol";
import {WithdrawalQueue, IWstETH} from "../../contracts/0.8.9/WithdrawalQueue.sol";
import {WithdrawalQueueERC721} from "../../contracts/0.8.9/WithdrawalQueueERC721.sol";

/**
 * @title Interface for VaultHub
 */
interface IVaultHub {
    function initialize(address _admin) external;
}

/**
 * @title Stake Limit State Data Structure
 */
struct StakeLimitStateData {
    uint32 prevStakeBlockNumber; // block number of the previous stake submit
    uint96 prevStakeLimit; // limit value (<= `maxStakeLimit`) obtained on the previous stake submit
    uint32 maxStakeLimitGrowthBlocks; // limit regeneration speed expressed in blocks
    uint96 maxStakeLimit; // maximum limit value
}

/**
 * @title Interface for Lido contract
 */
interface ILido {
    function getTotalShares() external view returns (uint256);
    function getExternalShares() external view returns (uint256);
    function mintExternalShares(address _recipient, uint256 _amountOfShares) external;
    function burnExternalShares(uint256 _amountOfShares) external;
    function setMaxExternalRatioBP(uint256 _maxExternalRatioBP) external;
    function initialize(address _lidoLocator, address _eip712StETH) external payable;
    function resumeStaking() external;
    function resume() external;
    function setStakingLimit(uint256 _maxStakeLimit, uint256 _stakeLimitIncreasePerBlock) external;
    function transfer(address _recipient, uint256 _amount) external returns (bool);
    function submit(address _referral) external payable returns (uint256);
    function getStakeLimitFullInfo()
        external
        view
        returns (
            bool isStakingPaused_,
            bool isStakingLimitSet,
            uint256 currentStakeLimit,
            uint256 maxStakeLimit,
            uint256 maxStakeLimitGrowthBlocks,
            uint256 prevStakeLimit,
            uint256 prevStakeBlockNumber
        );
    function approve(address _spender, uint256 _amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/**
 * @title Interface for Aragon Kernel
 */
interface IKernel {
    function acl() external view returns (IACL);
    function newAppInstance(
        bytes32 _appId,
        address _appBase,
        bytes calldata _initializePayload,
        bool _setDefault
    ) external;
}

/**
 * @title Interface for Aragon ACL
 */
interface IACL {
    function initialize(address _permissionsCreator) external;
    function createPermission(address _entity, address _app, bytes32 _role, address _manager) external;
    function hasPermission(address _who, address _where, bytes32 _what) external view returns (bool);
}

/**
 * @title Interface for Aragon DAO Factory
 */
interface IDaoFactory {
    function newDAO(address _root) external returns (IKernel);
}

/**
 * @title Base Protocol Test Contract
 * @notice Sets up the Lido protocol for testing
 */
contract BaseProtocolTest is Test {
    // Main protocol contracts
    ILido public lidoContract;
    LidoLocator public lidoLocator;
    WithdrawalQueueERC721 public wq;
    IACL public acl;
    SecondOpinionOracle__MockForAccountingFuzzing public secondOpinionOracleMock;
    IKernel private dao;

    // Account addresses
    address private rootAccount;
    address private userAccount;

    // Aragon DAO components
    address public kernelBase;
    address public aclBase;
    address public evmScriptRegistryFactory;
    address public daoFactoryAdr;

    // Protocol configuration
    address public depositContractAdr = address(0x4242424242424242424242424242424242424242);
    address public withdrawalQueueAdr = makeAddr("dummy-locator:withdrawalQueue");
    uint256 public genesisTimestamp = 1_695_902_400;
    address public lidoTreasuryAdr = makeAddr("dummy-lido:treasury");
    address public wstETHAdr = makeAddr("dummy-locator:wstETH");

    // Constants
    uint256 public constant VAULTS_LIMIT = 500;
    uint256 public constant VAULTS_RELATIVE_SHARE_LIMIT = 10_00;

    LimitsList public limitList =
        LimitsList({
            exitedValidatorsPerDayLimit: 9000,
            appearedValidatorsPerDayLimit: 43200,
            annualBalanceIncreaseBPLimit: 10_00,
            maxValidatorExitRequestsPerReport: 600,
            maxItemsPerExtraDataTransaction: 8,
            maxNodeOperatorsPerExtraDataItem: 24,
            requestTimestampMargin: 7680,
            maxPositiveTokenRebase: 750000,
            initialSlashingAmountPWei: 1000,
            inactivityPenaltiesAmountPWei: 101,
            clBalanceOraclesErrorUpperBPLimit: 50
        });

    /**
     * @notice Sets up the protocol with initial configuration
     * @param _startBalance Initial balance for the Lido contract
     * @param _rootAccount Admin account address
     * @param _userAccount User account address
     */
    function setUpProtocol(uint256 _startBalance, address _rootAccount, address _userAccount) public {
        rootAccount = _rootAccount;
        userAccount = _userAccount;

        // Deploy Lido implementation
        address impl = deployCode("Lido.sol:Lido");

        vm.startPrank(rootAccount);

        // Create Aragon DAO
        (dao, acl) = _createAragonDao();

        // Add Lido as an Aragon app
        address lidoProxyAddress = _addAragonApp(dao, impl);
        lidoContract = ILido(lidoProxyAddress);

        // Fund Lido contract
        vm.deal(lidoProxyAddress, _startBalance);

        // Set up permissions
        _setupLidoPermissions(lidoProxyAddress);

        // Set up staking router mock
        StakingRouter__MockForLidoAccountingFuzzing stakingRouter = _setupStakingRouterMock();

        // Deploy Lido locator
        lidoLocator = _deployLidoLocator(lidoProxyAddress, address(stakingRouter));

        // Deploy and set up protocol components
        _deployProtocolComponents(lidoProxyAddress);

        // Initialize VaultHub
        IVaultHub(lidoLocator.vaultHub()).initialize(rootAccount);

        // Deploy and initialize EIP712StETH
        address eip712steth = deployCode("EIP712StETH.sol:EIP712StETH", abi.encode(lidoProxyAddress));
        lidoContract.initialize(address(lidoLocator), address(eip712steth));

        // Deploy WstETH
        deployCodeTo("WstETH.sol:WstETH", abi.encode(lidoProxyAddress), wstETHAdr);

        // Set up withdrawal queue
        _setupWithdrawalQueue();

        vm.stopPrank();
    }

    /**
     * @notice Sets up permissions for the Lido contract
     * @param lidoProxyAddress Address of the Lido proxy
     */
    function _setupLidoPermissions(address lidoProxyAddress) internal {
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("STAKING_CONTROL_ROLE"), rootAccount);
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("STAKING_PAUSE_ROLE"), rootAccount);
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("RESUME_ROLE"), rootAccount);
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("PAUSE_ROLE"), rootAccount);
    }

    /**
     * @notice Sets up the staking router mock
     * @return StakingRouter__MockForLidoAccountingFuzzing The configured staking router mock
     */
    function _setupStakingRouterMock() internal returns (StakingRouter__MockForLidoAccountingFuzzing) {
        StakingRouter__MockForLidoAccountingFuzzing stakingRouter = new StakingRouter__MockForLidoAccountingFuzzing();

        uint96[] memory stakingModuleFees = new uint96[](3);
        stakingModuleFees[0] = 4876942047684326532;
        stakingModuleFees[1] = 145875332634464962;
        stakingModuleFees[2] = 38263043302959438;

        address[] memory recipients = new address[](3);
        recipients[0] = 0x55032650b14df07b85bF18A3a3eC8E0Af2e028d5;
        recipients[1] = 0xaE7B191A31f627b4eB1d4DaC64eaB9976995b433;
        recipients[2] = 0xdA7dE2ECdDfccC6c3AF10108Db212ACBBf9EA83F;

        stakingRouter.mock__getStakingRewardsDistribution(
            recipients,
            stakingModuleFees,
            9999999999999999996,
            100000000000000000000
        );

        return stakingRouter;
    }

    /**
     * @notice Deploys all protocol components
     * @param lidoProxyAddress Address of the Lido proxy
     */
    function _deployProtocolComponents(address lidoProxyAddress) internal {
        // Deploy Accounting
        address accountingImpl = deployCode(
            "Accounting.sol:Accounting",
            abi.encode(address(lidoLocator), lidoProxyAddress)
        );
        deployCodeTo(
            "OssifiableProxy.sol:OssifiableProxy",
            abi.encode(accountingImpl, rootAccount, new bytes(0)),
            lidoLocator.accounting()
        );

        // Deploy VaultHub
        address vaultHubImpl = deployCode(
            "VaultHub.sol:VaultHub",
            abi.encode(address(lidoLocator), lidoProxyAddress, VAULTS_LIMIT, VAULTS_RELATIVE_SHARE_LIMIT)
        );
        deployCodeTo(
            "OssifiableProxy.sol:OssifiableProxy",
            abi.encode(vaultHubImpl, rootAccount, new bytes(0)),
            lidoLocator.vaultHub()
        );

        // Deploy AccountingOracle
        deployCodeTo(
            "AccountingOracle.sol:AccountingOracle",
            abi.encode(address(lidoLocator), lidoLocator.legacyOracle(), 12, genesisTimestamp),
            lidoLocator.accountingOracle()
        );

        // Deploy Burner
        deployCodeTo(
            "Burner.sol:Burner",
            abi.encode(rootAccount, address(lidoLocator), lidoProxyAddress, 0, 0),
            lidoLocator.burner()
        );

        // Deploy EL Rewards Vault
        deployCodeTo(
            "LidoExecutionLayerRewardsVault.sol:LidoExecutionLayerRewardsVault",
            abi.encode(lidoProxyAddress, lidoTreasuryAdr),
            lidoLocator.elRewardsVault()
        );

        // Deploy Oracle Report Sanity Checker
        _deployOracleReportSanityChecker();
    }

    /**
     * @notice Deploys the Oracle Report Sanity Checker
     */
    function _deployOracleReportSanityChecker() internal {
        // Deploy the sanity checker
        deployCodeTo(
            "OracleReportSanityChecker.sol:OracleReportSanityChecker",
            abi.encode(
                address(lidoLocator),
                rootAccount,
                [
                    limitList.exitedValidatorsPerDayLimit,
                    limitList.appearedValidatorsPerDayLimit,
                    limitList.annualBalanceIncreaseBPLimit,
                    limitList.maxValidatorExitRequestsPerReport,
                    limitList.maxItemsPerExtraDataTransaction,
                    limitList.maxNodeOperatorsPerExtraDataItem,
                    limitList.requestTimestampMargin,
                    limitList.maxPositiveTokenRebase,
                    limitList.initialSlashingAmountPWei,
                    limitList.inactivityPenaltiesAmountPWei,
                    limitList.clBalanceOraclesErrorUpperBPLimit
                ]
            ),
            lidoLocator.oracleReportSanityChecker()
        );

        // Set up second opinion oracle mock
        secondOpinionOracleMock = new SecondOpinionOracle__MockForAccountingFuzzing();
        vm.store(
            lidoLocator.oracleReportSanityChecker(),
            bytes32(uint256(2)),
            bytes32(uint256(uint160(address(secondOpinionOracleMock))))
        );
    }

    /**
     * @notice Sets up the withdrawal queue
     */
    function _setupWithdrawalQueue() internal {
        wq = new WithdrawalQueueERC721(wstETHAdr, "withdrawalQueueERC721", "wstETH");
        vm.store(address(wq), keccak256("lido.Versioned.contractVersion"), bytes32(0));
        wq.initialize(rootAccount);
        wq.grantRole(keccak256("RESUME_ROLE"), rootAccount);
        wq.grantRole(keccak256("FINALIZE_ROLE"), rootAccount);
        wq.resume();
    }

    /**
     * @notice Creates an Aragon DAO and returns the kernel and ACL
     * @return IKernel The DAO kernel
     * @return IACL The DAO ACL
     */
    function _createAragonDao() internal returns (IKernel, IACL) {
        // Deploy Aragon components
        kernelBase = deployCode("Kernel.sol:Kernel", abi.encode(true));
        aclBase = deployCode("ACL.sol:ACL");
        evmScriptRegistryFactory = deployCode("EVMScriptRegistryFactory.sol:EVMScriptRegistryFactory");
        daoFactoryAdr = deployCode(
            "DAOFactory.sol:DAOFactory",
            abi.encode(kernelBase, aclBase, evmScriptRegistryFactory)
        );

        IDaoFactory daoFactory = IDaoFactory(daoFactoryAdr);

        // Create new DAO
        vm.recordLogs();
        daoFactory.newDAO(rootAccount);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address daoAddress = abi.decode(logs[logs.length - 1].data, (address));

        IKernel _dao = IKernel(address(daoAddress));
        IACL _acl = IACL(address(_dao.acl()));

        // Set up permissions
        _acl.createPermission(rootAccount, daoAddress, keccak256("APP_MANAGER_ROLE"), rootAccount);

        return (_dao, _acl);
    }

    /**
     * @notice Adds an Aragon app to the DAO and returns the proxy address
     * @param _dao The DAO kernel
     * @param _impl The implementation address
     * @return address The proxy address
     */
    function _addAragonApp(IKernel _dao, address _impl) internal returns (address) {
        vm.recordLogs();
        _dao.newAppInstance(keccak256(bytes("lido.aragonpm.test")), _impl, "", false);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        address proxyAddress = abi.decode(logs[logs.length - 1].data, (address));

        return proxyAddress;
    }

    /**
     * @notice Deploys Lido locator with default values
     * @param lido The Lido contract address
     * @param stakingRouterAddress The staking router address
     * @return LidoLocator The deployed Lido locator
     */
    function _deployLidoLocator(address lido, address stakingRouterAddress) internal returns (LidoLocator) {
        LidoLocator.Config memory config = LidoLocator.Config({
            accountingOracle: makeAddr("dummy-locator:accountingOracle"),
            depositSecurityModule: makeAddr("dummy-locator:depositSecurityModule"),
            elRewardsVault: makeAddr("dummy-locator:elRewardsVault"),
            legacyOracle: makeAddr("dummy-locator:legacyOracle"),
            lido: lido,
            oracleReportSanityChecker: makeAddr("dummy-locator:oracleReportSanityChecker"),
            postTokenRebaseReceiver: address(0),
            burner: makeAddr("dummy-locator:burner"),
            stakingRouter: stakingRouterAddress,
            treasury: makeAddr("dummy-locator:treasury"),
            validatorsExitBusOracle: makeAddr("dummy-locator:validatorsExitBusOracle"),
            withdrawalQueue: withdrawalQueueAdr,
            withdrawalVault: makeAddr("dummy-locator:withdrawalVault"),
            oracleDaemonConfig: makeAddr("dummy-locator:oracleDaemonConfig"),
            accounting: makeAddr("dummy-locator:accounting"),
            predepositGuarantee: makeAddr("dummy-locator:predeposit_guarantee"),
            wstETH: wstETHAdr,
            vaultHub: makeAddr("dummy-locator:vaultHub")
        });

        return LidoLocator(deployCode("LidoLocator.sol:LidoLocator", abi.encode(config)));
    }
}
