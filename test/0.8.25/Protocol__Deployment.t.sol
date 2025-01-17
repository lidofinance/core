// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity ^0.8.0;

import "forge-std/Test.sol";

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";

interface IAccounting {
    function initialize(address _admin) external;
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
    IACL public acl;
    IKernel private dao;

    address private rootAccount;
    address private userAccount;

    address public kernelBase;
    address public aclBase;
    address public evmScriptRegistryFactory;
    address public daoFactoryAdr;

    uint256 public genesisTimestamp = 1695902400;
    address private depositContract = address(0x4242424242424242424242424242424242424242);

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

        /// @dev deploy lido locator with dummy default values
        lidoLocator = _deployLidoLocator(lidoProxyAddress);

        // Add accounting contract with handler to the protocol
        address accountingImpl = deployCode(
            "Accounting.sol:Accounting",
            abi.encode([address(lidoLocator), lidoProxyAddress])
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

        // Add staking router contract to the protocol
        deployCodeTo("StakingRouter.sol:StakingRouter", abi.encode(depositContract), lidoLocator.stakingRouter());

        // Add oracle report sanity checker contract to the protocol
        deployCodeTo(
            "OracleReportSanityChecker.sol:OracleReportSanityChecker",
            abi.encode(address(lidoLocator), rootAccount, [1500, 1500, 1000, 2000, 8, 24, 128, 5000000, 1000, 101, 50]),
            lidoLocator.oracleReportSanityChecker()
        );

        IAccounting(lidoLocator.accounting()).initialize(rootAccount);

        /// @dev deploy eip712steth
        address eip712steth = deployCode("EIP712StETH.sol:EIP712StETH", abi.encode(lidoProxyAddress));

        lidoContract.initialize(address(lidoLocator), address(eip712steth));

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
    function _deployLidoLocator(address lido) internal returns (ILidoLocator) {
        LidoLocatorConfig memory config = LidoLocatorConfig({
            accountingOracle: makeAddr("dummy-locator:accountingOracle"),
            depositSecurityModule: makeAddr("dummy-locator:depositSecurityModule"),
            elRewardsVault: makeAddr("dummy-locator:elRewardsVault"),
            legacyOracle: makeAddr("dummy-locator:legacyOracle"),
            lido: lido,
            oracleReportSanityChecker: makeAddr("dummy-locator:oracleReportSanityChecker"),
            postTokenRebaseReceiver: address(0),
            burner: makeAddr("dummy-locator:burner"),
            stakingRouter: makeAddr("dummy-locator:stakingRouter"),
            treasury: makeAddr("dummy-locator:treasury"),
            validatorsExitBusOracle: makeAddr("dummy-locator:validatorsExitBusOracle"),
            withdrawalQueue: makeAddr("dummy-locator:withdrawalQueue"),
            withdrawalVault: makeAddr("dummy-locator:withdrawalVault"),
            oracleDaemonConfig: makeAddr("dummy-locator:oracleDaemonConfig"),
            accounting: makeAddr("dummy-locator:accounting"),
            wstETH: makeAddr("dummy-locator:wstETH")
        });

        return ILidoLocator(deployCode("LidoLocator.sol:LidoLocator", abi.encode(config)));
    }
}
