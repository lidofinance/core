// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

import "../../../../contracts/0.8.9/EIP712StETH.sol";
import "forge-std/Test.sol";

import {CommonBase} from "forge-std/Base.sol";
import {LidoLocator} from "../../../../contracts/0.8.9/LidoLocator.sol";
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

    address private rootAccount;
    address private userAccount;

    address public kernelBase;
    address public aclBase;
    address public evmScriptRegistryFactory;
    address public daoFactoryAdr;

    address public accounting = makeAddr("dummy-locator:accounting");

    function prepareLidoContract(uint256 _startBalance, address _rootAccount, address _userAccount) public {
        rootAccount = _rootAccount;
        userAccount = _userAccount;

        vm.startPrank(rootAccount);
            kernelBase = deployCode("Kernel.sol:Kernel", abi.encode(true));
            aclBase = deployCode("ACL.sol:ACL");
            evmScriptRegistryFactory = deployCode("EVMScriptRegistryFactory.sol:EVMScriptRegistryFactory");
            daoFactoryAdr = deployCode("DAOFactory.sol:DAOFactory",
                abi.encode(kernelBase, aclBase ,evmScriptRegistryFactory)
            );
        vm.stopPrank();

        IDaoFactory daoFactory = IDaoFactory(daoFactoryAdr);

        vm.recordLogs();
        daoFactory.newDAO(rootAccount);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (address daoAddress) = abi.decode(logs[logs.length - 1].data, (address));

        vm.startPrank(rootAccount);
            IKernel dao = IKernel(address(daoAddress));
            IACL acl = IACL(address(dao.acl()));
            acl.createPermission(rootAccount, daoAddress, keccak256("APP_MANAGER_ROLE"), rootAccount);
        vm.stopPrank();

        vm.startPrank(rootAccount);
            address impl = deployCode("Lido.sol:Lido");
            vm.recordLogs();
            dao.newAppInstance(keccak256(bytes("lido.aragonpm.test")), impl, "", false);
            logs = vm.getRecordedLogs();
        vm.stopPrank();

        (address lidoProxyAddress) = abi.decode(logs[logs.length - 1].data, (address));

        vm.startPrank(rootAccount);
            lidoContract = ILido(lidoProxyAddress);
        vm.stopPrank();

        vm.startPrank(rootAccount);
            acl.createPermission(userAccount, address(lidoContract), keccak256("STAKING_CONTROL_ROLE"), rootAccount);
            acl.createPermission(userAccount, address(lidoContract), keccak256("STAKING_PAUSE_ROLE"), rootAccount);
            acl.createPermission(userAccount, address(lidoContract), keccak256("RESUME_ROLE"), rootAccount);
            acl.createPermission(userAccount, address(lidoContract), keccak256("PAUSE_ROLE"), rootAccount);
            assertTrue(acl.hasPermission(userAccount, address(lidoContract), keccak256("STAKING_CONTROL_ROLE")));
        vm.stopPrank();

        vm.startPrank(rootAccount);
            LidoLocator locator = new LidoLocator( LidoLocator.Config({
                accountingOracle: makeAddr("dummy-locator:accountingOracle"),
                depositSecurityModule: makeAddr("dummy-locator:burner"),
                elRewardsVault: makeAddr("dummy-locator:depositSecurityModule"),
                legacyOracle: makeAddr("dummy-locator:elRewardsVault"),
                lido: address(lidoContract),
                oracleReportSanityChecker: makeAddr("dummy-locator:lido"),
                postTokenRebaseReceiver: makeAddr("dummy-locator:oracleDaemonConfig"),
                burner: makeAddr("dummy-locator:oracleReportSanityChecker"),
                stakingRouter: makeAddr("dummy-locator:postTokenRebaseReceiver"),
                treasury: makeAddr("dummy-locator:stakingRouter"),
                validatorsExitBusOracle: makeAddr("dummy-locator:treasury"),
                withdrawalQueue: makeAddr("dummy-locator:validatorsExitBusOracle"),
                withdrawalVault: makeAddr("dummy-locator:withdrawalQueue"),
                oracleDaemonConfig: makeAddr("dummy-locator:withdrawalVault"),
                accounting: accounting,
                wstETH: makeAddr("dummy-locator:wstETH")
            }));

            EIP712StETH eip712steth = new EIP712StETH(address(lidoContract));

            vm.deal(address(lidoContract), _startBalance);
            lidoContract.initialize(address(locator), address(eip712steth));
        vm.stopPrank();
    }
}
