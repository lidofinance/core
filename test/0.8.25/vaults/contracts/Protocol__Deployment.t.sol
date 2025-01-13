// SPDX-License-Identifier: UNLICENSED
// for testing purposes only
pragma solidity ^0.8.0;

import "contracts/0.8.9/EIP712StETH.sol";
import "forge-std/Test.sol";

import {CommonBase} from "forge-std/Base.sol";
import {LidoLocator} from "contracts/0.8.9/LidoLocator.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {Vm} from "forge-std/Vm.sol";
import {console2} from "forge-std/console2.sol";

interface ILido {
    function getTotalShares() external view returns (uint256);

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

    function newAppInstance(bytes32 _appId, address _appBase, bytes calldata _initializePayload, bool _setDefault) external;
}

interface IACL {
    function initialize(address _permissionsCreator) external;

    function createPermission(address _entity, address _app, bytes32 _role, address _manager) external;

    function hasPermission(address _who, address _where, bytes32 _what) external view returns (bool);
}

interface IDaoFactory {
    function newDAO(address _root) external returns (IKernel);
}

contract Protocol__Deployment is Test {
    ILido public lidoContract;
    ILidoLocator public lidoLocator;
    IACL private acl;

    address private rootAccount;
    address private userAccount;

    address public kernelBase;
    address public aclBase;
    address public evmScriptRegistryFactory;
    address public daoFactoryAdr;

    function prepareLidoContract(uint256 _startBalance, address _rootAccount, address _userAccount) public {
        rootAccount = _rootAccount;
        userAccount = _userAccount;

        vm.startPrank(rootAccount);

        (IKernel dao, IACL acl) = createAragonDao();

        address impl = deployCode("Lido.sol:Lido");

        address lidoProxyAddress = addAragonApp(dao, impl);

        lidoContract = ILido(lidoProxyAddress);

        acl.createPermission(userAccount, address(lidoContract), keccak256("STAKING_CONTROL_ROLE"), rootAccount);
        acl.createPermission(userAccount, address(lidoContract), keccak256("STAKING_PAUSE_ROLE"), rootAccount);
        acl.createPermission(userAccount, address(lidoContract), keccak256("RESUME_ROLE"), rootAccount);
        acl.createPermission(userAccount, address(lidoContract), keccak256("PAUSE_ROLE"), rootAccount);

        lidoLocator = deployLidoLocator(address(lidoContract));
        EIP712StETH eip712steth = new EIP712StETH(address(lidoContract));

        vm.deal(address(lidoContract), _startBalance);
        lidoContract.initialize(address(lidoLocator), address(eip712steth));
        vm.stopPrank();
    }

    function createAragonDao() private returns (IKernel, IACL) {
        kernelBase = deployCode("Kernel.sol:Kernel", abi.encode(true));
        aclBase = deployCode("ACL.sol:ACL");
        evmScriptRegistryFactory = deployCode("EVMScriptRegistryFactory.sol:EVMScriptRegistryFactory");
        daoFactoryAdr = deployCode("DAOFactory.sol:DAOFactory",
            abi.encode(kernelBase, aclBase, evmScriptRegistryFactory)
        );

        IDaoFactory daoFactory = IDaoFactory(daoFactoryAdr);

        vm.recordLogs();
        daoFactory.newDAO(rootAccount);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address daoAddress) = abi.decode(logs[logs.length - 1].data, (address));

        IKernel dao = IKernel(address(daoAddress));
        acl = IACL(address(dao.acl()));

        acl.createPermission(rootAccount, daoAddress, keccak256("APP_MANAGER_ROLE"), rootAccount);

        return (dao, acl);
    }

    function addAragonApp(IKernel dao, address lidoImpl) private returns (address) {
        vm.recordLogs();
        dao.newAppInstance(keccak256(bytes("lido.aragonpm.test")), lidoImpl, "", false);
        Vm.Log[] memory logs = vm.getRecordedLogs();

        (address lidoProxyAddress) = abi.decode(logs[logs.length - 1].data, (address));

        return lidoProxyAddress;
    }

    function deployLidoLocator(address lido) private returns (ILidoLocator) {
        return new LidoLocator(LidoLocator.Config({
            accountingOracle: makeAddr("dummy-locator:accountingOracle"),
            depositSecurityModule: makeAddr("dummy-locator:burner"),
            elRewardsVault: makeAddr("dummy-locator:depositSecurityModule"),
            legacyOracle: makeAddr("dummy-locator:elRewardsVault"),
            lido: lido,
            oracleReportSanityChecker: makeAddr("dummy-locator:lido"),
            postTokenRebaseReceiver: makeAddr("dummy-locator:oracleDaemonConfig"),
            burner: makeAddr("dummy-locator:oracleReportSanityChecker"),
            stakingRouter: makeAddr("dummy-locator:postTokenRebaseReceiver"),
            treasury: makeAddr("dummy-locator:stakingRouter"),
            validatorsExitBusOracle: makeAddr("dummy-locator:treasury"),
            withdrawalQueue: makeAddr("dummy-locator:validatorsExitBusOracle"),
            withdrawalVault: makeAddr("dummy-locator:withdrawalQueue"),
            oracleDaemonConfig: makeAddr("dummy-locator:withdrawalVault"),
            accounting: makeAddr("dummy-locator:accounting"),
            wstETH: makeAddr("dummy-locator:wstETH")
        }));
    }
}
