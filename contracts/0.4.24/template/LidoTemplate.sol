// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>

// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import {APMRegistryFactory} from "@aragon/os/contracts/factory/APMRegistryFactory.sol";
import {ACL} from "@aragon/os/contracts/acl/ACL.sol";
import {Repo} from "@aragon/os/contracts/apm/Repo.sol";
import {APMRegistry} from "@aragon/os/contracts/apm/APMRegistry.sol";
import {ENSSubdomainRegistrar} from "@aragon/os/contracts/ens/ENSSubdomainRegistrar.sol";
import {Kernel} from "@aragon/os/contracts/kernel/Kernel.sol";
import {ENS} from "@aragon/os/contracts/lib/ens/ENS.sol";
import {PublicResolver} from "@aragon/os/contracts/lib/ens/PublicResolver.sol";
import {DAOFactory} from "@aragon/os/contracts/factory/DAOFactory.sol";
import {IsContract} from "@aragon/os/contracts/common/IsContract.sol";
import {MiniMeToken, MiniMeTokenFactory} from "@aragon/minime/contracts/MiniMeToken.sol";
import {EVMScriptRegistry } from "@aragon/os/contracts/evmscript/EVMScriptRegistry.sol";


import {Agent} from "@aragon/apps-agent/contracts/Agent.sol";
import {Vault} from "@aragon/apps-vault/contracts/Vault.sol";

import {Voting} from "@aragon/apps-lido/apps/voting/contracts/Voting.sol";
import {Finance} from "@aragon/apps-finance/contracts/Finance.sol";
import {TokenManager} from "@aragon/apps-lido/apps/token-manager/contracts/TokenManager.sol";

import {IFIFSResolvingRegistrar} from "@aragon/id/contracts/IFIFSResolvingRegistrar.sol";

import {Lido} from "../Lido.sol";
import {NodeOperatorsRegistry} from "../nos/NodeOperatorsRegistry.sol";

contract LidoTemplate is IsContract {
    // Configuration errors
    string private constant ERROR_ZERO_OWNER = "TMPL_ZERO_OWNER";
    string private constant ERROR_ENS_NOT_CONTRACT = "TMPL_ENS_NOT_CONTRACT";
    string private constant ERROR_DAO_FACTORY_NOT_CONTRACT = "TMPL_DAO_FAC_NOT_CONTRACT";
    string private constant ERROR_MINIME_FACTORY_NOT_CONTRACT = "TMPL_MINIME_FAC_NOT_CONTRACT";
    string private constant ERROR_ARAGON_ID_NOT_CONTRACT = "TMPL_ARAGON_ID_NOT_CONTRACT";
    string private constant ERROR_APM_REGISTRY_FACTORY_NOT_CONTRACT = "TMPL_APM_REGISTRY_FAC_NOT_CONTRACT";
    string private constant ERROR_EMPTY_HOLDERS = "TMPL_EMPTY_HOLDERS";
    string private constant ERROR_BAD_AMOUNTS_LEN = "TMPL_BAD_AMOUNTS_LEN";
    string private constant ERROR_INVALID_ID = "TMPL_INVALID_ID";
    string private constant ERROR_UNEXPECTED_TOTAL_SUPPLY = "TMPL_UNEXPECTED_TOTAL_SUPPLY";

    // Operational errors
    string private constant ERROR_PERMISSION_DENIED = "TMPL_PERMISSION_DENIED";
    string private constant ERROR_REGISTRY_ALREADY_DEPLOYED = "TMPL_REGISTRY_ALREADY_DEPLOYED";
    string private constant ERROR_ENS_NODE_NOT_OWNED_BY_TEMPLATE = "TMPL_ENS_NODE_NOT_OWNED_BY_TEMPLATE";
    string private constant ERROR_REGISTRY_NOT_DEPLOYED = "TMPL_REGISTRY_NOT_DEPLOYED";
    string private constant ERROR_DAO_ALREADY_DEPLOYED = "TMPL_DAO_ALREADY_DEPLOYED";
    string private constant ERROR_DAO_NOT_DEPLOYED = "TMPL_DAO_NOT_DEPLOYED";
    string private constant ERROR_ALREADY_FINALIZED = "TMPL_ALREADY_FINALIZED";

    // Aragon app IDs
    bytes32 private constant ARAGON_AGENT_APP_ID = 0x9ac98dc5f995bf0211ed589ef022719d1487e5cb2bab505676f0d084c07cf89a; // agent.aragonpm.eth
    bytes32 private constant ARAGON_VAULT_APP_ID = 0x7e852e0fcfce6551c13800f1e7476f982525c2b5277ba14b24339c68416336d1; // vault.aragonpm.eth
    bytes32 private constant ARAGON_VOTING_APP_ID = 0x9fa3927f639745e587912d4b0fea7ef9013bf93fb907d29faeab57417ba6e1d4; // voting.aragonpm.eth
    bytes32 private constant ARAGON_FINANCE_APP_ID = 0xbf8491150dafc5dcaee5b861414dca922de09ccffa344964ae167212e8c673ae; // finance.aragonpm.eth
    bytes32 private constant ARAGON_TOKEN_MANAGER_APP_ID =
        0x6b20a3010614eeebf2138ccec99f028a61c811b3b1a3343b6ff635985c75c91f; // token-manager.aragonpm.eth

    // APM app names, see https://github.com/aragon/aragonOS/blob/f3ae59b/contracts/apm/APMRegistry.sol#L11
    string private constant APM_APP_NAME = "apm-registry";
    string private constant APM_REPO_APP_NAME = "apm-repo";
    string private constant APM_ENSSUB_APP_NAME = "apm-enssub";

    // Aragon app names
    string private constant ARAGON_AGENT_APP_NAME = "aragon-agent";
    string private constant ARAGON_FINANCE_APP_NAME = "aragon-finance";
    string private constant ARAGON_TOKEN_MANAGER_APP_NAME = "aragon-token-manager";
    string private constant ARAGON_VOTING_APP_NAME = "aragon-voting";

    // Lido app names
    string private constant LIDO_APP_NAME = "lido";
    string private constant NODE_OPERATORS_REGISTRY_APP_NAME = "node-operators-registry";
    string private constant SIMPLE_DVT_APP_NAME = "simple-dvt";

    // DAO config constants
    bool private constant TOKEN_TRANSFERABLE = true;
    uint8 private constant TOKEN_DECIMALS = uint8(18);
    uint64 private constant DEFAULT_FINANCE_PERIOD = uint64(30 days);
    uint256 private constant TOKEN_MAX_PER_ACCOUNT = 0;

    struct APMRepos {
        Repo lido;
        Repo nodeOperatorsRegistry;
        Repo simpleDVT;
        Repo aragonAgent;
        Repo aragonFinance;
        Repo aragonTokenManager;
        Repo aragonVoting;
    }

    struct DeployState {
        bytes32 lidoRegistryEnsNode;
        APMRegistry lidoRegistry;
        Kernel dao;
        ACL acl;
        MiniMeToken token;
        Agent agent;
        Finance finance;
        TokenManager tokenManager;
        Voting voting;
        Lido lido;
        NodeOperatorsRegistry operators;
        NodeOperatorsRegistry sdvt;
        address stakingRouter;
    }

    struct AppVersion {
        address contractAddress;
        bytes contentURI;
    }

    address private owner;
    ENS private ens;
    DAOFactory private daoFactory;
    MiniMeTokenFactory private miniMeFactory;
    IFIFSResolvingRegistrar private aragonID;
    APMRegistryFactory private apmRegistryFactory;

    DeployState private deployState;
    APMRepos public apmRepos;

    event TmplAPMDeployed(address apm);
    event TmplReposCreated();
    event TmplAppInstalled(address appProxy, bytes32 appId, bytes initializeData);
    event TmplDAOAndTokenDeployed(address dao, address token);
    event TmplTokensIssued(uint256 totalAmount);
    event TmplDaoFinalized();

    modifier onlyOwner() {
        require(msg.sender == owner, ERROR_PERMISSION_DENIED);
        _;
    }

    function setOwner(address _newOwner) external onlyOwner {
        owner = _newOwner;
    }

    constructor(
        address _owner,
        DAOFactory _daoFactory,
        ENS _ens,
        MiniMeTokenFactory _miniMeFactory,
        IFIFSResolvingRegistrar _aragonID,
        APMRegistryFactory _apmRegistryFactory
    ) public {
        require(_owner != address(0), ERROR_ZERO_OWNER);
        require(isContract(address(_daoFactory)), ERROR_DAO_FACTORY_NOT_CONTRACT);
        require(isContract(address(_ens)), ERROR_ENS_NOT_CONTRACT);
        require(isContract(address(_miniMeFactory)), ERROR_MINIME_FACTORY_NOT_CONTRACT);
        require(isContract(address(_aragonID)), ERROR_ARAGON_ID_NOT_CONTRACT);
        require(isContract(address(_apmRegistryFactory)), ERROR_APM_REGISTRY_FACTORY_NOT_CONTRACT);

        owner = _owner;
        daoFactory = _daoFactory;
        ens = _ens;
        miniMeFactory = _miniMeFactory;
        aragonID = _aragonID;
        apmRegistryFactory = _apmRegistryFactory;
    }

    function getConfig()
        external
        view
        returns (
            address _owner,
            address _daoFactory,
            address _ens,
            address _miniMeFactory,
            address _aragonID,
            address _apmRegistryFactory
        )
    {
        return (owner, daoFactory, ens, miniMeFactory, aragonID, apmRegistryFactory);
    }

    function deployLidoAPM(bytes32 _tld, bytes32 _label) external onlyOwner {
        require(deployState.lidoRegistry == address(0), ERROR_REGISTRY_ALREADY_DEPLOYED);

        bytes32 node = keccak256(abi.encodePacked(_tld, _label));
        require(ens.owner(node) == address(this), ERROR_ENS_NODE_NOT_OWNED_BY_TEMPLATE);
        deployState.lidoRegistryEnsNode = node;

        APMRegistryFactory factory = apmRegistryFactory;

        // transfer ENS node ownership to the APM factory, which will
        // subsequently transfer it to the subdomain registrar
        ens.setOwner(node, factory);

        // make the template a (temporary) manager of the APM registry
        APMRegistry registry = factory.newAPM(_tld, _label, address(this));

        // APMRegistryFactory doesn't revoke its permission to create repos
        ACL(registry.kernel().acl()).revokePermission(factory, registry, registry.CREATE_REPO_ROLE());

        deployState.lidoRegistry = registry;

        emit TmplAPMDeployed(address(registry));
    }

    /**
     * @dev An escape hatch function to reclaim the domain if APM fails to deploy.
     */
    function cancelAndTransferDomain(bytes32 node, address _to) external onlyOwner {
        require(ens.owner(node) == address(this), ERROR_ENS_NODE_NOT_OWNED_BY_TEMPLATE);
        ens.setOwner(node, _to);
    }

    function createStdAragonRepos(
        address _agentImpl,
        address _financeImpl,
        address _tokenManagerImpl,
        address _votingImpl
    ) external onlyOwner {
        uint16[3] memory initialSemanticVersion = [uint16(1), uint16(0), uint16(0)];

        bytes memory dummyContentURI = new bytes(0);

        APMRegistry lidoRegistry = deployState.lidoRegistry;

        apmRepos.aragonAgent = lidoRegistry.newRepoWithVersion(
            ARAGON_AGENT_APP_NAME,
            this,
            initialSemanticVersion,
            _agentImpl,
            dummyContentURI
        );

        apmRepos.aragonFinance = lidoRegistry.newRepoWithVersion(
            ARAGON_FINANCE_APP_NAME,
            this,
            initialSemanticVersion,
            _financeImpl,
            dummyContentURI
        );

        apmRepos.aragonTokenManager = lidoRegistry.newRepoWithVersion(
            ARAGON_TOKEN_MANAGER_APP_NAME,
            this,
            initialSemanticVersion,
            _tokenManagerImpl,
            dummyContentURI
        );

        apmRepos.aragonVoting = lidoRegistry.newRepoWithVersion(
            ARAGON_VOTING_APP_NAME,
            this,
            initialSemanticVersion,
            _votingImpl,
            dummyContentURI
        );
    }

    function createRepos(
        uint16[3] _initialSemanticVersion,
        address _lidoImplAddress,
        bytes _lidoContentURI,
        address _nodeOperatorsRegistryImplAddress,
        bytes _nodeOperatorsRegistryContentURI
    ) external onlyOwner {
        require(deployState.lidoRegistry != address(0), ERROR_REGISTRY_NOT_DEPLOYED);

        APMRegistry lidoRegistry = deployState.lidoRegistry;

        // create Lido app repos

        apmRepos.lido = lidoRegistry.newRepoWithVersion(
            LIDO_APP_NAME,
            this,
            _initialSemanticVersion,
            _lidoImplAddress,
            _lidoContentURI
        );

        apmRepos.nodeOperatorsRegistry = lidoRegistry.newRepoWithVersion(
            NODE_OPERATORS_REGISTRY_APP_NAME,
            this,
            _initialSemanticVersion,
            _nodeOperatorsRegistryImplAddress,
            _nodeOperatorsRegistryContentURI
        );

        apmRepos.simpleDVT = lidoRegistry.newRepoWithVersion(
            SIMPLE_DVT_APP_NAME,
            this,
            _initialSemanticVersion,
            _nodeOperatorsRegistryImplAddress,
            _nodeOperatorsRegistryContentURI
        );

        emit TmplReposCreated();
    }

    function newDAO(string _tokenName, string _tokenSymbol, uint64[4] _votingSettings) external onlyOwner {
        DeployState memory state = deployState;

        require(state.lidoRegistry != address(0), ERROR_REGISTRY_NOT_DEPLOYED);
        require(state.dao == address(0), ERROR_DAO_ALREADY_DEPLOYED);

        state.token = _createToken(_tokenName, _tokenSymbol, TOKEN_DECIMALS);
        (state.dao, state.acl) = _createDAO();

        state.agent = _installAgentApp(state.lidoRegistryEnsNode, state.dao);

        state.finance = _installFinanceApp(state.lidoRegistryEnsNode, state.dao, state.agent, DEFAULT_FINANCE_PERIOD);

        state.tokenManager = _installTokenManagerApp(
            state.lidoRegistryEnsNode,
            state.dao,
            state.token,
            TOKEN_TRANSFERABLE,
            TOKEN_MAX_PER_ACCOUNT
        );

        state.voting = _installVotingApp(
            state.lidoRegistryEnsNode,
            state.dao,
            state.token,
            _votingSettings[0], // support
            _votingSettings[1], // acceptance
            _votingSettings[2], // duration
            _votingSettings[3] // objectionPhaseDuration
        );

        bytes memory noInit = new bytes(0);

        state.lido = Lido(
            _installNonDefaultApp(state.dao, _getAppId(LIDO_APP_NAME, state.lidoRegistryEnsNode), noInit)
        );

        state.operators = NodeOperatorsRegistry(
            _installNonDefaultApp(
                state.dao,
                _getAppId(NODE_OPERATORS_REGISTRY_APP_NAME, state.lidoRegistryEnsNode),
                noInit
            )
        );

        state.sdvt = NodeOperatorsRegistry(
            _installNonDefaultApp(
                state.dao,
                _getAppId(SIMPLE_DVT_APP_NAME, state.lidoRegistryEnsNode),
                noInit
            )
        );

        // used for issuing vested tokens in the next step
        _createTokenManagerPermissionsForTemplate(state.acl, state.tokenManager);

        emit TmplDAOAndTokenDeployed(address(state.dao), address(state.token));

        deployState = state;
    }

    function issueTokens(
        address[] _holders,
        uint256[] _amounts,
        uint64 _vestingStart,
        uint64 _vestingCliff,
        uint64 _vestingEnd,
        bool _vestingRevokable,
        uint256 _expectedFinalTotalSupply
    ) external onlyOwner {
        require(_holders.length > 0, ERROR_EMPTY_HOLDERS);
        require(_holders.length == _amounts.length, ERROR_BAD_AMOUNTS_LEN);

        TokenManager tokenManager = deployState.tokenManager;
        require(tokenManager != address(0), ERROR_DAO_NOT_DEPLOYED);

        uint256 totalAmount = _issueTokens(
            tokenManager,
            deployState.token,
            _holders,
            _amounts,
            _vestingStart,
            _vestingCliff,
            _vestingEnd,
            _vestingRevokable,
            _expectedFinalTotalSupply
        );

        emit TmplTokensIssued(totalAmount);
    }

    function finalizeDAO(string _daoName, uint256 _unvestedTokensAmount, address _stakingRouter) external onlyOwner {
        require(_stakingRouter != address(0));
        DeployState memory state = deployState;
        APMRepos memory repos = apmRepos;

        require(state.dao != address(0), ERROR_DAO_NOT_DEPLOYED);
        require(bytes(_daoName).length > 0, ERROR_INVALID_ID);

        state.stakingRouter = _stakingRouter;

        if (_unvestedTokensAmount != 0) {
            // using issue + assign to avoid setting the additional MINT_ROLE for the template
            state.tokenManager.issue(_unvestedTokensAmount);
            state.tokenManager.assign(state.agent, _unvestedTokensAmount);
            emit TmplTokensIssued(_unvestedTokensAmount);
        }

        _setupPermissions(state, repos);
        _transferRootPermissionsFromTemplateAndFinalizeDAO(state.dao, state.voting);
        _resetState();

        aragonID.register(keccak256(abi.encodePacked(_daoName)), state.dao);

        emit TmplDaoFinalized();
    }

    /* DAO AND APPS */

    /**
     * @dev Create a DAO using the DAO Factory and grant the template root permissions so it has full
     *      control during setup. Once the DAO setup has finished, it is recommended to call the
     *      `_transferRootPermissionsFromTemplateAndFinalizeDAO()` helper to transfer the root
     *      permissions to the end entity in control of the organization.
     */
    function _createDAO() private returns (Kernel dao, ACL acl) {
        dao = daoFactory.newDAO(this);
        acl = ACL(dao.acl());
        _createPermissionForTemplate(acl, dao, dao.APP_MANAGER_ROLE());
    }

    function _installAgentApp(bytes32 _lidoRegistryEnsNode, Kernel _dao) private returns (Agent) {
        bytes32 appId = _getAppId(ARAGON_AGENT_APP_NAME, _lidoRegistryEnsNode);
        bytes memory initializeData = abi.encodeWithSelector(Agent(0).initialize.selector);
        Agent agent = Agent(_installApp(_dao, appId, initializeData, true));
        _dao.setRecoveryVaultAppId(appId);
        return agent;
    }

    function _installFinanceApp(
        bytes32 _lidoRegistryEnsNode,
        Kernel _dao,
        Vault _vault,
        uint64 _periodDuration
    ) private returns (Finance) {
        bytes32 appId = _getAppId(ARAGON_FINANCE_APP_NAME, _lidoRegistryEnsNode);
        bytes memory initializeData = abi.encodeWithSelector(Finance(0).initialize.selector, _vault, _periodDuration);
        return Finance(_installNonDefaultApp(_dao, appId, initializeData));
    }

    function _installTokenManagerApp(
        bytes32 _lidoRegistryEnsNode,
        Kernel _dao,
        MiniMeToken _token,
        bool _transferable,
        uint256 _maxAccountTokens
    ) private returns (TokenManager) {
        bytes32 appId = _getAppId(ARAGON_TOKEN_MANAGER_APP_NAME, _lidoRegistryEnsNode);
        TokenManager tokenManager = TokenManager(_installNonDefaultApp(_dao, appId, new bytes(0)));
        _token.changeController(tokenManager);
        tokenManager.initialize(_token, _transferable, _maxAccountTokens);
        return tokenManager;
    }

    function _installVotingApp(
        bytes32 _lidoRegistryEnsNode,
        Kernel _dao,
        MiniMeToken _token,
        uint64 _support,
        uint64 _acceptance,
        uint64 _duration,
        uint64 _objectionPhaseDuration
    ) private returns (Voting) {
        bytes32 appId = _getAppId(ARAGON_VOTING_APP_NAME, _lidoRegistryEnsNode);
        bytes memory initializeData = abi.encodeWithSelector(
            Voting(0).initialize.selector,
            _token,
            _support,
            _acceptance,
            _duration,
            _objectionPhaseDuration
        );
        return Voting(_installNonDefaultApp(_dao, appId, initializeData));
    }

    function _installNonDefaultApp(
        Kernel _dao,
        bytes32 _appId,
        bytes memory _initializeData
    ) internal returns (address) {
        return _installApp(_dao, _appId, _initializeData, false);
    }

    function _installApp(
        Kernel _dao,
        bytes32 _appId,
        bytes memory _initializeData,
        bool _setDefault
    ) internal returns (address) {
        address latestBaseAppAddress = _apmResolveLatest(_appId).contractAddress;
        address instance = address(_dao.newAppInstance(_appId, latestBaseAppAddress, _initializeData, _setDefault));
        emit TmplAppInstalled(instance, _appId, _initializeData);
        return instance;
    }

    /* TOKEN */

    function _createToken(string memory _name, string memory _symbol, uint8 _decimals) internal returns (MiniMeToken) {
        MiniMeToken token = miniMeFactory.createCloneToken(MiniMeToken(address(0)), 0, _name, _decimals, _symbol, true);
        return token;
    }

    function _issueTokens(
        TokenManager _tokenManager,
        MiniMeToken _token,
        address[] memory _holders,
        uint256[] memory _amounts,
        uint64 _vestingStart,
        uint64 _vestingCliff,
        uint64 _vestingEnd,
        bool _vestingRevokable,
        uint256 _expectedFinalTotalSupply
    ) private returns (uint256 totalAmount) {
        totalAmount = 0;
        uint256 i;

        for (i = 0; i < _holders.length; ++i) {
            totalAmount += _amounts[i];
        }

        _tokenManager.issue(totalAmount);
        require(_token.totalSupply() == _expectedFinalTotalSupply, ERROR_UNEXPECTED_TOTAL_SUPPLY);

        for (i = 0; i < _holders.length; ++i) {
            _tokenManager.assignVested(
                _holders[i],
                _amounts[i],
                _vestingStart,
                _vestingCliff,
                _vestingEnd,
                _vestingRevokable
            );
        }

        return totalAmount;
    }

    /* PERMISSIONS */

    function _setupPermissions(DeployState memory _state, APMRepos memory _repos) private {
        ACL acl = _state.acl;
        Voting voting = _state.voting;

        _createAgentPermissions(acl, _state.agent, voting);
        _createVaultPermissions(acl, _state.agent, _state.finance, voting);
        _createFinancePermissions(acl, _state.finance, voting);
        _createEvmScriptsRegistryPermissions(acl, voting);
        _createVotingPermissions(acl, voting, _state.tokenManager);
        _configureTokenManagerPermissions(acl, _state.tokenManager, voting);

        // APM

        Kernel apmDAO = Kernel(_state.lidoRegistry.kernel());
        ACL apmACL = ACL(apmDAO.acl());
        bytes32 REPO_CREATE_VERSION_ROLE = _repos.lido.CREATE_VERSION_ROLE();
        ENSSubdomainRegistrar apmRegistrar = _state.lidoRegistry.registrar();

        _transferPermissionFromTemplate(apmACL, _state.lidoRegistry, voting, _state.lidoRegistry.CREATE_REPO_ROLE());
        apmACL.setPermissionManager(voting, apmDAO, apmDAO.APP_MANAGER_ROLE());
        _transferPermissionFromTemplate(apmACL, apmACL, voting, apmACL.CREATE_PERMISSIONS_ROLE());
        apmACL.setPermissionManager(voting, apmRegistrar, apmRegistrar.CREATE_NAME_ROLE());
        apmACL.setPermissionManager(voting, apmRegistrar, apmRegistrar.POINT_ROOTNODE_ROLE());

        // APM repos

        // using loops to save contract size
        Repo[9] memory repoAddresses;
        repoAddresses[0] = _repos.lido;
        repoAddresses[1] = _repos.nodeOperatorsRegistry;
        repoAddresses[2] = _repos.aragonAgent;
        repoAddresses[3] = _repos.aragonFinance;
        repoAddresses[4] = _repos.aragonTokenManager;
        repoAddresses[5] = _repos.aragonVoting;
        repoAddresses[6] = _resolveRepo(_getAppId(APM_APP_NAME, _state.lidoRegistryEnsNode));
        repoAddresses[7] = _resolveRepo(_getAppId(APM_REPO_APP_NAME, _state.lidoRegistryEnsNode));
        repoAddresses[8] = _resolveRepo(_getAppId(APM_ENSSUB_APP_NAME, _state.lidoRegistryEnsNode));
        for (uint256 i = 0; i < repoAddresses.length; ++i) {
            _transferPermissionFromTemplate(apmACL, repoAddresses[i], voting, REPO_CREATE_VERSION_ROLE);
        }

        // using loops to save contract size
        bytes32[6] memory perms;

        // NodeOperatorsRegistry
        perms[0] = _state.operators.MANAGE_SIGNING_KEYS();
        perms[1] = _state.operators.SET_NODE_OPERATOR_LIMIT_ROLE();
        for (i = 0; i < 2; ++i) {
            _createPermissionForVoting(acl, _state.operators, perms[i], voting);
        }
        acl.createPermission(_state.stakingRouter, _state.operators, _state.operators.STAKING_ROUTER_ROLE(), voting);
        acl.createPermission(_state.agent, _state.operators, _state.operators.MANAGE_NODE_OPERATOR_ROLE(), voting);

        // SimpleDVT
        perms[0] = _state.operators.MANAGE_SIGNING_KEYS();
        perms[1] = _state.operators.SET_NODE_OPERATOR_LIMIT_ROLE();
        perms[2] = _state.operators.MANAGE_NODE_OPERATOR_ROLE();
        for (i = 0; i < 3; ++i) {
            _createPermissionForVoting(acl, _state.sdvt, perms[i], voting);
        }
        acl.createPermission(_state.stakingRouter, _state.sdvt, _state.sdvt.STAKING_ROUTER_ROLE(), this);
        acl.grantPermission(_state.agent, _state.sdvt, _state.sdvt.STAKING_ROUTER_ROLE());

        _transferPermissionFromTemplate(acl, _state.sdvt, voting, _state.sdvt.STAKING_ROUTER_ROLE());

        // Lido
        perms[0] = _state.lido.PAUSE_ROLE();
        perms[1] = _state.lido.RESUME_ROLE();
        perms[2] = _state.lido.STAKING_PAUSE_ROLE();
        perms[3] = _state.lido.STAKING_CONTROL_ROLE();
        perms[4] = _state.lido.UNSAFE_CHANGE_DEPOSITED_VALIDATORS_ROLE();
        for (i = 0; i < 5; ++i) {
            _createPermissionForVoting(acl, _state.lido, perms[i], voting);
        }
    }

    function _createTokenManagerPermissionsForTemplate(ACL _acl, TokenManager _tokenManager) internal {
        _createPermissionForTemplate(_acl, _tokenManager, _tokenManager.ISSUE_ROLE());
        _createPermissionForTemplate(_acl, _tokenManager, _tokenManager.ASSIGN_ROLE());
    }

    function _createPermissionForVoting(ACL _acl, address _app, bytes32 perm, address _voting) internal {
        _acl.createPermission(_voting, _app, perm, _voting);
    }

    function _createAgentPermissions(ACL _acl, Agent _agent, address _voting) internal {
        _createPermissionForVoting(_acl, _agent, _agent.EXECUTE_ROLE(), _voting);
        _createPermissionForVoting(_acl, _agent, _agent.RUN_SCRIPT_ROLE(), _voting);
    }

    function _createVaultPermissions(ACL _acl, Vault _vault, address _finance, address _voting) internal {
        _acl.createPermission(_finance, _vault, _vault.TRANSFER_ROLE(), _voting);
    }

    function _createFinancePermissions(ACL _acl, Finance _finance, address _voting) internal {
        _createPermissionForVoting(_acl, _finance, _finance.EXECUTE_PAYMENTS_ROLE(), _voting);
        _createPermissionForVoting(_acl, _finance, _finance.MANAGE_PAYMENTS_ROLE(), _voting);
        _createPermissionForVoting(_acl, _finance, _finance.CREATE_PAYMENTS_ROLE(), _voting);
    }

    function _createEvmScriptsRegistryPermissions(ACL _acl, address _voting) internal {
        EVMScriptRegistry registry = EVMScriptRegistry(_acl.getEVMScriptRegistry());
        _createPermissionForVoting(_acl, registry, registry.REGISTRY_MANAGER_ROLE(), _voting);
        _createPermissionForVoting(_acl, registry, registry.REGISTRY_ADD_EXECUTOR_ROLE(), _voting);
    }

    function _createVotingPermissions(ACL _acl, Voting _voting, address _tokenManager) internal {
        _createPermissionForVoting(_acl, _voting, _voting.MODIFY_QUORUM_ROLE(), _voting);
        _createPermissionForVoting(_acl, _voting, _voting.MODIFY_SUPPORT_ROLE(), _voting);
        _acl.createPermission(_tokenManager, _voting, _voting.CREATE_VOTES_ROLE(), _voting);
    }

    function _configureTokenManagerPermissions(ACL _acl, TokenManager _tokenManager, address _voting) internal {
        _removePermissionFromTemplate(_acl, _tokenManager, _tokenManager.ISSUE_ROLE());
        _removePermissionFromTemplate(_acl, _tokenManager, _tokenManager.ASSIGN_ROLE());
        _createPermissionForVoting(_acl, _tokenManager, _tokenManager.ASSIGN_ROLE(), _voting);
    }

    function _createPermissionForTemplate(ACL _acl, address _app, bytes32 _permission) private {
        _acl.createPermission(address(this), _app, _permission, address(this));
    }

    function _removePermissionFromTemplate(ACL _acl, address _app, bytes32 _permission) private {
        _acl.revokePermission(address(this), _app, _permission);
        _acl.removePermissionManager(_app, _permission);
    }

    function _transferRootPermissionsFromTemplateAndFinalizeDAO(Kernel _dao, address _voting) private {
        ACL _acl = ACL(_dao.acl());
        _transferPermissionFromTemplate(_acl, _dao, _voting, _dao.APP_MANAGER_ROLE(), _voting);
        _transferPermissionFromTemplate(_acl, _acl, _voting, _acl.CREATE_PERMISSIONS_ROLE(), _voting);
    }

    function _transferPermissionFromTemplate(ACL _acl, address _app, address _to, bytes32 _permission) private {
        _transferPermissionFromTemplate(_acl, _app, _to, _permission, _to);
    }

    function _transferPermissionFromTemplate(
        ACL _acl,
        address _app,
        address _to,
        bytes32 _permission,
        address _manager
    ) private {
        _acl.grantPermission(_to, _app, _permission);
        _acl.revokePermission(address(this), _app, _permission);
        _acl.setPermissionManager(_manager, _app, _permission);
    }

    /* APM and ENS */

    function _apmResolveLatest(bytes32 _appId) private view returns (AppVersion memory) {
        Repo repo = _resolveRepo(_appId);
        (, address contractAddress, bytes memory contentURI) = repo.getLatest();
        return AppVersion(contractAddress, contentURI);
    }

    function _resolveRepo(bytes32 _appId) private view returns (Repo) {
        address resolverAddress = ens.resolver(_appId);
        require(resolverAddress != address(0x0), "ZERO_RESOLVER_ADDRESS");
        return Repo(PublicResolver(resolverAddress).addr(_appId));
    }

    /**
     * @return the app ID: ENS node with name `_appName` and parent node `_apmRootNode`.
     */
    function _getAppId(string _appName, bytes32 _apmRootNode) private pure returns (bytes32 subnode) {
        return keccak256(abi.encodePacked(_apmRootNode, keccak256(abi.encodePacked(_appName))));
    }

    /* STATE RESET */

    function _resetState() private {
        delete deployState.lidoRegistryEnsNode;
        delete deployState.lidoRegistry;
        delete deployState.dao;
        delete deployState.acl;
        delete deployState.token;
        delete deployState.agent;
        delete deployState.finance;
        delete deployState.tokenManager;
        delete deployState.voting;
        delete deployState.lido;
        delete deployState.operators;
        delete deployState;
        delete apmRepos.lido;
        delete apmRepos.nodeOperatorsRegistry;
        delete apmRepos.aragonAgent;
        delete apmRepos.aragonFinance;
        delete apmRepos.aragonTokenManager;
        delete apmRepos.aragonVoting;
        delete apmRepos;
    }
}
