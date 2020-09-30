pragma solidity 0.4.24;

import "@aragon/templates-shared/contracts/BaseTemplate.sol";

import "@depools/dao/contracts/StETH.sol";
import "@depools/dao/contracts/oracle/DePoolOracle.sol";
import "@depools/dao/contracts/sps/StakingProvidersRegistry.sol";
import "@depools/dao/contracts/DePool.sol";


contract DePoolTemplate is BaseTemplate {
    /* Hardcoded constants to save gas
     * bytes32 internal constant DEPOOLS_PM_NODE = keccak256(abi.encodePacked(ETH_TLD_NODE, keccak256(abi.encodePacked("depoolspm"))));
     */
    bytes32 internal constant DEPOOLS_PM_NODE = 0x974a6fb4d8c9712163277101d2e355f655dd9b93ea96f4021f78c02265c221d7;

    /* Hardcoded constant to save gas
     * bytes32 internal constant STETH_APP_ID = keccak256(abi.encodePacked(DEPOOLS_PM_NODE, keccak256(abi.encodePacked("steth")))); // steth.depoolspm.eth
     * bytes32 internal constant DEPOOLORACLE_APP_ID = keccak256(abi.encodePacked(DEPOOLS_PM_NODE, keccak256(abi.encodePacked("depooloracle")))); // depooloracle.depoolspm.eth
     * bytes32 internal constant REGISTRY_APP_ID = keccak256(abi.encodePacked(DEPOOLS_PM_NODE, keccak256(abi.encodePacked("staking-providers-registry")))); // staking-providers-registry.depoolspm.eth
     * bytes32 internal constant DEPOOL_APP_ID = keccak256(abi.encodePacked(DEPOOLS_PM_NODE, keccak256(abi.encodePacked("depool")))); // depool.depoolspm.eth
     */
    bytes32 constant internal STETH_APP_ID = 0x5937d846addd00601bf692837c2cd9854dacd2c55911625da04aec9c62a61a26;
    bytes32 constant internal DEPOOLORACLE_APP_ID = 0xebe89ae11ec5a76827463bd202b0551f137fdc6dad7cd69ecdf4fe553af5f77b;
    bytes32 internal constant REGISTRY_APP_ID = 0x6ca5078df26de2bcf0976b0bfba50b6ed5dac3644879214556e2789dfc78df16;
    bytes32 constant internal DEPOOL_APP_ID = 0xdf4019658a996b6bc3639baa07d25c655bf826334fc5c81bb83e501905b51cb1;

    bool constant private TOKEN_TRANSFERABLE = true;
    uint8 constant private TOKEN_DECIMALS = uint8(18);
    uint256 constant private TOKEN_MAX_PER_ACCOUNT = uint256(0);

    uint64 constant private DEFAULT_FINANCE_PERIOD = uint64(30 days);

    // Storing temporary vars in storage to avoid hitting the `CompilerError: Stack too deep`
    Kernel private dao;
    ACL private acl;
    MiniMeToken private token;
    Vault private agentOrVault;
    Finance private finance;
    TokenManager private tokenManager;
    Voting private voting;
    StETH private steth;
    DePoolOracle private oracle;
    StakingProvidersRegistry private sps;
    DePool private depool;


    constructor(DAOFactory _daoFactory, ENS _ens, MiniMeTokenFactory _miniMeFactory, IFIFSResolvingRegistrar _aragonID)
        BaseTemplate(_daoFactory, _ens, _miniMeFactory, _aragonID)
        public
    {
        _ensureAragonIdIsValid(_aragonID);
        _ensureMiniMeFactoryIsValid(_miniMeFactory);
    }

    function newDAO(
        string _id,
        string _tokenName,
        string _tokenSymbol,
        address[] _holders,
        uint256[] _stakes,
        uint64[3] _votingSettings,
        address _ETH2ValidatorRegistrationContract
    )
        external
    {
        _validateId(_id);
        require(_holders.length > 0, "COMPANY_EMPTY_HOLDERS");
        require(_holders.length == _stakes.length, "COMPANY_BAD_HOLDERS_STAKES_LEN");

        // setup apps
        token = _createToken(_tokenName, _tokenSymbol, TOKEN_DECIMALS);
        (dao, acl) = _createDAO();
        _setupApps(_votingSettings, _ETH2ValidatorRegistrationContract);

        // oracle setPool
        _createPermissionForTemplate(acl, oracle, oracle.SET_POOL());
        oracle.setPool(depool);
        _removePermissionFromTemplate(acl, oracle, oracle.SET_POOL());

        // StakingProvidersRegistry setPool
        _createPermissionForTemplate(acl, sps, sps.SET_POOL());
        sps.setPool(depool);
        _removePermissionFromTemplate(acl, sps, sps.SET_POOL());

        _mintTokens(acl, tokenManager, _holders, _stakes);

        _setupPermissions();

        _transferRootPermissionsFromTemplateAndFinalizeDAO(dao, voting);
        _registerID(_id, dao);

        _reset();   // revert the cells back to get a refund
    }

    function _setupApps(
        uint64[3] memory _votingSettings,
        address _ETH2ValidatorRegistrationContract
    )
        internal
    {
        agentOrVault = _installDefaultAgentApp(dao);
        finance = _installFinanceApp(dao, agentOrVault, DEFAULT_FINANCE_PERIOD);
        tokenManager = _installTokenManagerApp(dao, token, TOKEN_TRANSFERABLE, TOKEN_MAX_PER_ACCOUNT);
        voting = _installVotingApp(dao, token, _votingSettings);

        bytes memory initializeData = abi.encodeWithSelector(StETH(0).initialize.selector);
        steth = StETH(_installNonDefaultApp(dao, STETH_APP_ID, initializeData));

        initializeData = abi.encodeWithSelector(DePoolOracle(0).initialize.selector);
        oracle = DePoolOracle(_installNonDefaultApp(dao, DEPOOLORACLE_APP_ID, initializeData));

        initializeData = abi.encodeWithSelector(StakingProvidersRegistry(0).initialize.selector);
        sps = StakingProvidersRegistry(_installNonDefaultApp(dao, REGISTRY_APP_ID, initializeData));

        initializeData = abi.encodeWithSelector(DePool(0).initialize.selector,
                                                steth, _ETH2ValidatorRegistrationContract, oracle, sps);
        depool = DePool(_installNonDefaultApp(dao, DEPOOL_APP_ID, initializeData));
    }

    function _setupPermissions(
    )
        internal
    {
        _createAgentPermissions(acl, Agent(agentOrVault), voting, voting);
        _createVaultPermissions(acl, agentOrVault, finance, voting);
        _createFinancePermissions(acl, finance, voting, voting);
        _createFinanceCreatePaymentsPermission(acl, finance, voting, voting);
        _createEvmScriptsRegistryPermissions(acl, voting, voting);
        _createVotingPermissions(acl, voting, voting, tokenManager, voting);
        _createTokenManagerPermissions(acl, tokenManager, voting, voting);

        // StETH
        acl.createPermission(voting, steth, steth.PAUSE_ROLE(), voting);
        acl.createPermission(depool, steth, steth.MINT_ROLE(), voting);
        acl.createPermission(depool, steth, steth.BURN_ROLE(), voting);

        // Oracle
        acl.createPermission(voting, oracle, oracle.MANAGE_MEMBERS(), voting);
        acl.createPermission(voting, oracle, oracle.MANAGE_QUORUM(), voting);
        acl.createPermission(voting, oracle, oracle.SET_POOL(), voting);

        // StakingProvidersRegistry
        acl.createPermission(voting, sps, sps.MANAGE_SIGNING_KEYS(), voting);
        acl.createPermission(voting, sps, sps.ADD_STAKING_PROVIDER_ROLE(), voting);
        acl.createPermission(voting, sps, sps.SET_STAKING_PROVIDER_ACTIVE_ROLE(), voting);
        acl.createPermission(voting, sps, sps.SET_STAKING_PROVIDER_NAME_ROLE(), voting);
        acl.createPermission(voting, sps, sps.SET_STAKING_PROVIDER_ADDRESS_ROLE(), voting);
        acl.createPermission(voting, sps, sps.SET_STAKING_PROVIDER_LIMIT_ROLE(), voting);
        acl.createPermission(voting, sps, sps.REPORT_STOPPED_VALIDATORS_ROLE(), voting);
        acl.createPermission(voting, sps, sps.SET_POOL(), voting);

        // Pool
        acl.createPermission(voting, depool, depool.PAUSE_ROLE(), voting);
        acl.createPermission(voting, depool, depool.MANAGE_FEE(), voting);
        acl.createPermission(voting, depool, depool.MANAGE_WITHDRAWAL_KEY(), voting);
        acl.createPermission(voting, depool, depool.SET_ORACLE(), voting);
    }

    /// @dev reset temporary storage
    function _reset() private {
        delete dao;
        delete acl;
        delete token;
        delete agentOrVault;
        delete finance;
        delete tokenManager;
        delete voting;
        delete steth;
        delete oracle;
        delete sps;
        delete depool;
    }
}
