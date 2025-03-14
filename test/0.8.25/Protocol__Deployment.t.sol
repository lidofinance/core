// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import "forge-std/Test.sol";
import {CommonBase} from "forge-std/Base.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";
import {StdCheats} from "forge-std/StdCheats.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {LimitsList} from "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol";

import {StakingRouter__MockForLidoAccountingFuzzing} from "./contracts/StakingRouter__MockForLidoAccountingFuzzing.sol";
import {SecondOpinionOracle__MockForAccountingFuzzing} from "./contracts/SecondOpinionOracle__MockForAccountingFuzzing.sol";
import {WithdrawalQueue, IWstETH} from "../../contracts/0.8.9/WithdrawalQueue.sol";
import {WithdrawalQueueERC721} from "../../contracts/0.8.9/WithdrawalQueueERC721.sol";

interface IAccounting {
    function initialize(address _admin) external;
}

struct StakeLimitStateData {
    uint32 prevStakeBlockNumber; // block number of the previous stake submit
    uint96 prevStakeLimit; // limit value (<= `maxStakeLimit`) obtained on the previous stake submit
    uint32 maxStakeLimitGrowthBlocks; // limit regeneration speed expressed in blocks
    uint96 maxStakeLimit; // maximum limit value
}

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

interface IKernel {
    function acl() external view returns (IACL);

    function newAppInstance(
        bytes32 _appId,
        address _appBase,
        bytes calldata _initializePayload,
        bool _setDefault
    ) external;
}

interface IACL {
    function initialize(address _permissionsCreator) external;

    function createPermission(address _entity, address _app, bytes32 _role, address _manager) external;

    function hasPermission(address _who, address _where, bytes32 _what) external view returns (bool);
}

interface IDaoFactory {
    function newDAO(address _root) external returns (IKernel);
}

struct LidoLocatorConfig {
    address accountingOracle;
    address depositSecurityModule;
    address elRewardsVault;
    address legacyOracle;
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
    address wstETH;
}

contract BaseProtocolTest is Test {
    ILido public lidoContract;
    ILidoLocator public lidoLocator;
    WithdrawalQueueERC721 public wq;
    IACL public acl;
    SecondOpinionOracle__MockForAccountingFuzzing public secondOpinionOracleMock;
    IKernel private dao;

    address private rootAccount;
    address private userAccount;

    address public kernelBase;
    address public aclBase;
    address public evmScriptRegistryFactory;
    address public daoFactoryAdr;

    uint256 public genesisTimestamp = 1_695_902_400;
    address private depositContractAdr = address(0x4242424242424242424242424242424242424242);
    address private withdrawalQueueAdr = makeAddr("dummy-locator:withdrawalQueue");
    address public lidoTreasuryAdr = makeAddr("dummy-lido:treasury");
    address public wstETHAdr = makeAddr("dummy-locator:wstETH");

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

    function setUpProtocol(uint256 _startBalance, address _rootAccount, address _userAccount) public {
        rootAccount = _rootAccount;
        userAccount = _userAccount;

        address impl = deployCode("Lido.sol:Lido");

        vm.startPrank(rootAccount);
        (dao, acl) = createAragonDao();

        address lidoProxyAddress = addAragonApp(dao, impl);

        lidoContract = ILido(lidoProxyAddress);

        /// @dev deal lido contract with start balance
        vm.deal(lidoProxyAddress, _startBalance);

        acl.createPermission(userAccount, lidoProxyAddress, keccak256("STAKING_CONTROL_ROLE"), rootAccount);
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("STAKING_PAUSE_ROLE"), rootAccount);
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("RESUME_ROLE"), rootAccount);
        acl.createPermission(userAccount, lidoProxyAddress, keccak256("PAUSE_ROLE"), rootAccount);

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

        /// @dev deploy lido locator with dummy default values
        lidoLocator = _deployLidoLocator(lidoProxyAddress, address(stakingRouter));

        // Add accounting contract with handler to the protocol
        address accountingImpl = deployCode(
            "Accounting.sol:Accounting",
            abi.encode(address(lidoLocator), lidoProxyAddress, VAULTS_LIMIT, VAULTS_RELATIVE_SHARE_LIMIT)
        );

        deployCodeTo(
            "OssifiableProxy.sol:OssifiableProxy",
            abi.encode(accountingImpl, rootAccount, new bytes(0)),
            lidoLocator.accounting()
        );

        deployCodeTo(
            "AccountingOracle.sol:AccountingOracle",
            abi.encode(
                address(lidoLocator),
                lidoLocator.legacyOracle(),
                12, // secondsPerSlot
                genesisTimestamp
            ),
            lidoLocator.accountingOracle()
        );

        // Add burner contract to the protocol
        deployCodeTo(
            "Burner.sol:Burner",
            abi.encode(rootAccount, address(lidoLocator), lidoProxyAddress, 0, 0),
            lidoLocator.burner()
        );

        // Add burner contract to the protocol
        deployCodeTo(
            "LidoExecutionLayerRewardsVault.sol:LidoExecutionLayerRewardsVault",
            abi.encode(lidoProxyAddress, lidoTreasuryAdr),
            lidoLocator.elRewardsVault()
        );

        // Add oracle report sanity checker contract to the protocol
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

        secondOpinionOracleMock = new SecondOpinionOracle__MockForAccountingFuzzing();
        vm.store(
            lidoLocator.oracleReportSanityChecker(),
            bytes32(uint256(2)),
            bytes32(uint256(uint160(address(secondOpinionOracleMock))))
        );

        IAccounting(lidoLocator.accounting()).initialize(rootAccount);

        /// @dev deploy eip712steth
        address eip712steth = deployCode("EIP712StETH.sol:EIP712StETH", abi.encode(lidoProxyAddress));

        lidoContract.initialize(address(lidoLocator), address(eip712steth));

        deployCodeTo("WstETH.sol:WstETH", abi.encode(lidoProxyAddress), wstETHAdr);

        wq = new WithdrawalQueueERC721(wstETHAdr, "withdrawalQueueERC721", "wstETH");
        vm.store(address(wq), keccak256("lido.Versioned.contractVersion"), bytes32(0));
        wq.initialize(rootAccount);
        wq.grantRole(keccak256("RESUME_ROLE"), rootAccount);
        wq.grantRole(keccak256("FINALIZE_ROLE"), rootAccount);

        wq.resume();

        vm.stopPrank();
    }

    /// @dev create aragon dao and return kernel and acl
    function createAragonDao() private returns (IKernel, IACL) {
        kernelBase = deployCode("Kernel.sol:Kernel", abi.encode(true));
        aclBase = deployCode("ACL.sol:ACL");
        evmScriptRegistryFactory = deployCode("EVMScriptRegistryFactory.sol:EVMScriptRegistryFactory");
        daoFactoryAdr = deployCode(
            "DAOFactory.sol:DAOFactory",
            abi.encode(kernelBase, aclBase, evmScriptRegistryFactory)
        );

        IDaoFactory daoFactory = IDaoFactory(daoFactoryAdr);

        vm.recordLogs();
        daoFactory.newDAO(rootAccount);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        address daoAddress = abi.decode(logs[logs.length - 1].data, (address));

        IKernel _dao = IKernel(address(daoAddress));
        IACL _acl = IACL(address(_dao.acl()));

        _acl.createPermission(rootAccount, daoAddress, keccak256("APP_MANAGER_ROLE"), rootAccount);

        return (_dao, _acl);
    }

    /// @dev add aragon app to dao and return proxy address
    function addAragonApp(IKernel _dao, address _impl) private returns (address) {
        vm.recordLogs();
        _dao.newAppInstance(keccak256(bytes("lido.aragonpm.test")), _impl, "", false);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        address proxyAddress = abi.decode(logs[logs.length - 1].data, (address));

        return proxyAddress;
    }

    /// @dev deploy lido locator with dummy default values
    function _deployLidoLocator(address lido, address stakingRouterAddress) internal returns (ILidoLocator) {
        LidoLocatorConfig memory config = LidoLocatorConfig({
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
            wstETH: wstETHAdr
        });

        return ILidoLocator(deployCode("LidoLocator.sol:LidoLocator", abi.encode(config)));
    }
}
