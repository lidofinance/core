// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {RandomLib} from "./RandomLib.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {Merkle} from "murky/src/Merkle.sol";
import {console2} from "forge-std/console2.sol";

contract LidoLocatorMock is ILidoLocator {
    address public predepositGuarantee_;
    address public accounting_;
    address public treasury_;

    constructor(address _predepositGuarantee, address _accounting, address _treasury) {
        predepositGuarantee_ = _predepositGuarantee;
        accounting_ = _accounting;
        treasury_ = _treasury;
    }

    function predepositGuarantee() external view returns (address) {
        return predepositGuarantee_;
    }

    function accounting() external view returns (address) {
        return accounting_;
    }

    function treasury() external view returns (address) {
        return treasury_;
    }

    function accountingOracle() external view returns (address) {
        return address(0);
    }

    function depositSecurityModule() external view returns (address) {
        return address(0);
    }

    function elRewardsVault() external view returns (address) {
        return address(0);
    }

    function legacyOracle() external view returns (address) {
        return address(0);
    }

    function lido() external view returns (address) {
        return address(0);
    }

    function oracleReportSanityChecker() external view returns (address) {
        return address(0);
    }

    function burner() external view returns (address) {
        return address(0);
    }

    function stakingRouter() external view returns (address) {
        return address(0);
    }

    function validatorsExitBusOracle() external view returns (address) {
        return address(0);
    }

    function withdrawalQueue() external view returns (address) {
        return address(0);
    }

    function withdrawalVault() external view returns (address) {
        return address(0);
    }

    function postTokenRebaseReceiver() external view returns (address) {
        return address(0);
    }

    function oracleDaemonConfig() external view returns (address) {
        return address(0);
    }

    function wstETH() external view returns (address) {
        return address(0);
    }

    function vaultHub() external view returns (address) {
        return address(0);
    }

    function coreComponents()
        external
        view
        returns (
            address elRewardsVault,
            address oracleReportSanityChecker,
            address stakingRouter,
            address treasury,
            address withdrawalQueue,
            address withdrawalVault
        )
    {
        return (address(0), address(0), address(0), address(0), address(0), address(0));
    }
    function oracleReportComponents()
        external
        view
        returns (
            address accountingOracle,
            address oracleReportSanityChecker,
            address burner,
            address withdrawalQueue,
            address postTokenRebaseReceiver,
            address stakingRouter,
            address vaultHub
        )
    {
        return (address(0), address(0), address(0), address(0), address(0), address(0), address(0));
    }
}

contract LidoMock is ILido {
    uint256 totalShares;
    uint256 externalShares;
    uint256 totalPooledEther;
    uint256 bufferedEther;

    constructor(uint256 _totalShares, uint256 _totalPooledEther, uint256 _externalShares) {
        if (_totalShares == 0) revert("totalShares cannot be 0");
        if (_totalPooledEther == 0) revert("totalPooledEther cannot be 0");

        totalShares = _totalShares;
        totalPooledEther = _totalPooledEther;
        externalShares = _externalShares;
    }

    function getSharesByPooledEth(uint256 _ethAmount) public view returns (uint256) {
        return (_ethAmount * totalShares) / totalPooledEther;
    }

    function getPooledEthByShares(uint256 _sharesAmount) public view returns (uint256) {
        return (_sharesAmount * totalPooledEther) / totalShares;
    }

    function getTotalShares() external view returns (uint256) {
        return totalShares;
    }

    function getExternalShares() external view returns (uint256) {
        return externalShares;
    }

    function mintExternalShares(address _recipient, uint256 _amountOfShares) external {
        totalShares += _amountOfShares;
        externalShares += _amountOfShares;
    }

    function burnExternalShares(uint256 _amountOfShares) external {
        totalShares -= _amountOfShares;
        externalShares -= _amountOfShares;
    }

    function stake() external payable {
        uint256 sharesAmount = getSharesByPooledEth(msg.value);
        totalShares += sharesAmount;
        totalPooledEther += msg.value;
    }

    function receiveRewards(uint256 _rewards) external {
        totalPooledEther += _rewards;
    }

    function getExternalEther() external view returns (uint256) {
        return _getExternalEther(totalPooledEther);
    }

    function _getExternalEther(uint256 _internalEther) internal view returns (uint256) {
        return (externalShares * _internalEther) / (totalShares - externalShares);
    }

    function rebalanceExternalEtherToInternal() external payable {
        uint256 shares = getSharesByPooledEth(msg.value);
        if (shares > externalShares) revert("not enough external shares");
        externalShares -= shares;
        totalPooledEther += msg.value;
    }

    function getPooledEthBySharesRoundUp(uint256 _sharesAmount) external view returns (uint256) {
        return (_sharesAmount * totalPooledEther) / totalShares;
    }

    function transferSharesFrom(address, address, uint256) external returns (uint256) {
        return 0;
    }

    function transferShares(address, uint256) external returns (uint256) {
        return 0;
    }

    function getTotalPooledEther() external view returns (uint256) {
        return totalPooledEther;
    }

    function getBeaconStat()
        external
        view
        returns (uint256 depositedValidators, uint256 beaconValidators, uint256 beaconBalance)
    {
        return (100, 100, 100);
    }

    function processClStateUpdate(
        uint256 _reportTimestamp,
        uint256 _preClValidators,
        uint256 _reportClValidators,
        uint256 _reportClBalance
    ) external {}

    function collectRewardsAndProcessWithdrawals(
        uint256 _reportTimestamp,
        uint256 _reportClBalance,
        uint256 _adjustedPreCLBalance,
        uint256 _withdrawalsToWithdraw,
        uint256 _elRewardsToWithdraw,
        uint256 _lastWithdrawalRequestToFinalize,
        uint256 _simulatedShareRate,
        uint256 _etherToLockOnWithdrawalQueue
    ) external {}

    function emitTokenRebase(
        uint256 _reportTimestamp,
        uint256 _timeElapsed,
        uint256 _preTotalShares,
        uint256 _preTotalEther,
        uint256 _postTotalShares,
        uint256 _postTotalEther,
        uint256 _postInternalShares,
        uint256 _postInternalEther,
        uint256 _sharesMintedAsFees
    ) external {}

    function mintShares(address _recipient, uint256 _sharesAmount) external {
        totalShares += _sharesAmount;
    }

    function burnShares(uint256 _amountOfShares) external {
        totalShares -= _amountOfShares;
    }

    function permit(
        address owner,
        address spender,
        uint256 value,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {}

    function nonces(address owner) external view returns (uint256) {
        return 100;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return bytes32(0);
    }

    function totalSupply() external view returns (uint256) {
        return 100;
    }

    function balanceOf(address account) external view returns (uint256) {
        return 100;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        return true;
    }

    function allowance(address owner, address spender) external view returns (uint256) {
        return 100;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        return true;
    }
}

contract RewardSimulator is Test {
    using RandomLib for RandomLib.Storage;

    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant APR_DENOMINATOR = 10000;
    uint256 constant DAYS_PER_YEAR = 365;

    uint256 internal immutable APR_MIN;
    uint256 internal immutable APR_MAX;
    uint256 internal immutable MIN_VALIDATOR_BALANCE;

    uint256 private currentAPR;
    uint256 private lastRewardTimestamp;
    RandomLib.Storage private rnd;

    constructor(uint256 _seed, uint256 _aprMin, uint256 _aprMax, uint256 _minValidatorBalance) {
        rnd.seed = _seed;
        lastRewardTimestamp = block.timestamp;
        APR_MIN = _aprMin;
        APR_MAX = _aprMax;
        MIN_VALIDATOR_BALANCE = _minValidatorBalance;
        currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
    }

    function getDailyReward() public returns (uint256) {
        uint256 timePassed = block.timestamp - lastRewardTimestamp;
        if (timePassed < SECONDS_PER_DAY) {
            return 0;
        }

        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        lastRewardTimestamp += daysPassed * SECONDS_PER_DAY;

        uint256 yearlyReward = (MIN_VALIDATOR_BALANCE * currentAPR) / APR_DENOMINATOR;
        uint256 dailyReward = (yearlyReward * daysPassed) / DAYS_PER_YEAR;

        int256 randomVariation = int256(rnd.randInt(200)) - 100;
        dailyReward = uint256((int256(dailyReward) * (1000 + randomVariation)) / 1000);

        if (rnd.randBool()) {
            currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
        }

        return dailyReward;
    }
}

contract VaultHubTest is Test {
    using RandomLib for RandomLib.Storage;

    struct Vault {
        StakingVault stakingVaultProxy;
        bool isValidatorPerformingWell;
        uint256 lifetime;
        uint256 badBehaviourIterations;
    }

    enum VaultAction {
        Mint,
        Burn,
        Rebalance
    }

    enum VaultState {
        MintingAllowed,
        Healthy,
        Unhealthy,
        BadDebt
    }

    enum TestMode {
        BadPerformingValidators,
        WellPerformingValidators,
        All
    }

    VaultHub vaultHubProxy;
    LidoMock lido;
    DepositContract__MockForStakingVault depositContract;
    RewardSimulator rewardSimulatorForValidator;
    RewardSimulator rewardSimulatorForCoreProtocol;

    address owner = makeAddr("owner");
    address predepositGuarantee = makeAddr("predepositGuarantee");
    address accounting = makeAddr("accounting");
    address treasury = makeAddr("treasury");
    address depositor = makeAddr("depositor");
    address nodeOperator = makeAddr("nodeOperator");

    RandomLib.Storage private rnd;

    uint256 internal constant ITERATIONS = 200;
    uint256 internal constant CONNECTED_VAULTS_LIMIT = 100;
    uint256 internal constant BAD_BEHAVIOUR_ITERATIONS_LIMIT = 10;
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    uint256 internal constant SECONDS_PER_DAY = 86400;
    uint256 internal constant LOCKED_AMOUNT = 32 ether;
    uint256 internal constant MAX_USERS_TO_STAKING = 100;

    Vault[] private vaults;
    uint256 private totalSharesMinted;
    uint256 private totalSharesBurned;
    uint256 private connectedVaults;
    uint256 private disconnectedVaults;
    uint256 private relativeShareLimitBp;

    function deploy(uint256 _seed) public {
        rnd.seed = _seed;

        depositContract = new DepositContract__MockForStakingVault();

        lido = new LidoMock(7810237 * 10 ** 18, 9365361 * 10 ** 18, 0);
        LidoLocatorMock lidoLocator = new LidoLocatorMock(depositor, accounting, treasury);
        relativeShareLimitBp = 1000;
        VaultHub vaultHub = new VaultHub(lidoLocator, lido, relativeShareLimitBp);
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(vaultHub),
            abi.encodeWithSelector(VaultHub.initialize.selector, owner)
        );
        vaultHubProxy = VaultHub(payable(address(proxy)));

        bytes32 vaultMasterRole = vaultHubProxy.VAULT_MASTER_ROLE();
        vm.prank(owner);
        vaultHubProxy.grantRole(vaultMasterRole, owner);

        bytes32 vaultRegistryRole = vaultHubProxy.VAULT_REGISTRY_ROLE();
        vm.prank(owner);
        vaultHubProxy.grantRole(vaultRegistryRole, owner);

        rewardSimulatorForValidator = new RewardSimulator(_seed, 300, 400, 32 ether);
        rewardSimulatorForCoreProtocol = new RewardSimulator(_seed, 100, 200, lido.getTotalPooledEther());
    }

    function createAndConnectVault(bool _addCodehash) internal {
        StakingVault stakingVault = new StakingVault(address(vaultHubProxy), address(depositContract));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, owner, nodeOperator, depositor, "0x")
        );
        StakingVault stakingVaultProxy = StakingVault(payable(address(proxy)));

        vm.prank(owner);
        stakingVaultProxy.authorizeLidoVaultHub();

        if (_addCodehash) {
            vm.prank(owner);
            vaultHubProxy.addVaultProxyCodehash(address(stakingVaultProxy).codehash);
        }

        deal(address(owner), LOCKED_AMOUNT);
        vm.prank(owner);
        stakingVaultProxy.fund{value: LOCKED_AMOUNT}();

        vm.prank(owner);
        stakingVaultProxy.lock(LOCKED_AMOUNT);

        vm.prank(owner);
        vaultHubProxy.connectVault(address(stakingVaultProxy), 10 ** 18, 1000, 800, 500);

        Vault memory vault = Vault({
            stakingVaultProxy: stakingVaultProxy,
            isValidatorPerformingWell: rnd.randBool(),
            lifetime: rnd.randInt(ITERATIONS / 2),
            badBehaviourIterations: 0
        });
        vaults.push(vault);

        console2.log("Creating and connecting vault", address(stakingVaultProxy));

        connectedVaults++;
    }

    function runTests(uint256 _seed, TestMode _testMode) internal {
        deploy(_seed);

        createAndConnectVault(true);

        for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
            if (vaults.length < CONNECTED_VAULTS_LIMIT && rnd.randInt(100) < 10) {
                createAndConnectVault(false);
            }

            vm.warp(block.timestamp + SECONDS_PER_DAY / 2);

            doRandomActions(_testMode);
            transitionRandomCoreProtocolStaking();
            transitionRandomCoreProtocolReceiveReward();
            checkVaultsForShareLimits();
            removeAndDisconnectDeadVault();
            updateReportAndVaultData();
        }

        assertEq(connectedVaults, disconnectedVaults + vaults.length);

        uint256 sharesLeftover = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            Vault memory vault = vaults[i];
            sharesLeftover += vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy)).sharesMinted;
        }
        console2.log("Total shares minted", totalSharesMinted);
        console2.log("Total shares burned", totalSharesBurned);
        console2.log("Shares leftover", sharesLeftover);

        assertEq(totalSharesMinted, totalSharesBurned + sharesLeftover);
    }

    function padDataIfNeeded(bytes32[] memory _data) internal view returns (bytes32[] memory) {
        if (_data.length == 1) {
            bytes32[] memory paddedData = new bytes32[](2);
            paddedData[0] = _data[0];
            paddedData[1] = bytes32(0);
            return paddedData;
        }
        return _data;
    }

    function updateReportAndVaultData() internal {
        if (vaults.length == 0) {
            return;
        }
        Merkle merkle = new Merkle();
        bytes32[] memory data = new bytes32[](vaults.length);
        for (uint256 i = 0; i < vaults.length; i++) {
            Vault storage vault = vaults[i];
            data[i] = keccak256(
                bytes.concat(
                    keccak256(
                        abi.encode(
                            address(vault.stakingVaultProxy),
                            address(vault.stakingVaultProxy).balance,
                            vault.stakingVaultProxy.inOutDelta(),
                            0,
                            vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy)).sharesMinted
                        )
                    )
                )
            );
        }

        bytes32[] memory paddedData = padDataIfNeeded(data);
        bytes32 root = merkle.getRoot(paddedData);

        vm.prank(accounting);
        vaultHubProxy.updateReportData(uint64(block.timestamp), root, "test-cid");

        for (uint256 i = 0; i < vaults.length; i++) {
            Vault storage vault = vaults[i];
            uint256 valuation = address(vault.stakingVaultProxy).balance;
            int256 inOutDelta = vault.stakingVaultProxy.inOutDelta();
            uint256 treasureFeeShares = 0;
            uint256 sharesMinted = vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy)).sharesMinted;

            bytes32[] memory proof = merkle.getProof(paddedData, i);
            bytes32 valueToProve = paddedData[i];

            assertTrue(merkle.verifyProof(root, proof, valueToProve));

            vaultHubProxy.updateVaultData(
                address(vault.stakingVaultProxy),
                valuation,
                inOutDelta,
                treasureFeeShares,
                sharesMinted,
                proof
            );
        }
    }

    function checkVaultsForShareLimits() internal {
        for (uint256 i = 0; i < vaults.length; i++) {
            Vault memory vault = vaults[i];
            uint256 sharesMinted = vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy)).sharesMinted;

            assertLe(lido.getPooledEthBySharesRoundUp(sharesMinted), vault.stakingVaultProxy.valuation());

            uint256 relativeMaxShareLimitPerVault = (lido.getTotalShares() * relativeShareLimitBp) / TOTAL_BASIS_POINTS;
            assertLe(sharesMinted, relativeMaxShareLimitPerVault);
        }
    }

    function disconnectVault(Vault memory _vault) internal {
        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_vault.stakingVaultProxy));
        if (socket.sharesMinted > 0) {
            vm.prank(owner);
            vaultHubProxy.burnShares(address(_vault.stakingVaultProxy), socket.sharesMinted);
            totalSharesBurned += socket.sharesMinted;
        }
        vm.prank(owner);
        vaultHubProxy.disconnect(address(_vault.stakingVaultProxy));

        disconnectedVaults++;
    }

    function removeAndDisconnectDeadVault() internal {
        uint256 vaultsLength = vaults.length;
        for (uint256 i = 0; i < vaultsLength; i++) {
            Vault storage vault = vaults[i];
            if (vault.lifetime > 0) {
                vault.lifetime--;
            }

            if (vault.lifetime == 0) {
                disconnectVault(vault);
                Vault memory lastVault = vaults[vaultsLength - 1];
                vaults[i] = lastVault;
                vaults.pop();
                vaultsLength--;
            }
        }
    }

    function doRandomActions(TestMode _testMode) internal {
        for (uint256 vaultIdx = 0; vaultIdx < vaults.length; vaultIdx++) {
            Vault storage vault = vaults[vaultIdx];

            printVaultState(vault);

            VaultAction action = VaultAction(rnd.randInt(2));
            if (action == VaultAction.Mint) {
                transitionRandomMint(vault.stakingVaultProxy);
            } else if (action == VaultAction.Burn) {
                transitionRandomBurn(vault.stakingVaultProxy);
            } else if (action == VaultAction.Rebalance) {
                transitionRandomRebalance(vault.stakingVaultProxy);
            }

            if (
                _testMode == TestMode.WellPerformingValidators ||
                (_testMode == TestMode.All && vault.isValidatorPerformingWell)
            ) {
                transitionVaultRandomReceiveReward(vault.stakingVaultProxy);
            } else if (
                _testMode == TestMode.BadPerformingValidators ||
                (_testMode == TestMode.All && !vault.isValidatorPerformingWell)
            ) {
                if (getVaultState(vault) == VaultState.Unhealthy) {
                    vault.badBehaviourIterations++;
                }
                if (vault.badBehaviourIterations > BAD_BEHAVIOUR_ITERATIONS_LIMIT) {
                    vault.lifetime = 0;
                } else {
                    transitionVaultRandomPenalty(vault.stakingVaultProxy);
                }
            }
        }
    }

    function testSolvencyAllTransitions() external {
        runTests(5686631772487049791906286, TestMode.All);
    }

    function testSolvencyBadPerformingValidators() external {
        runTests(5686631772487049791906286, TestMode.BadPerformingValidators);
    }

    function testSolvencyWellPerformingValidators() external {
        runTests(5686631772487049791906286, TestMode.WellPerformingValidators);
    }

    function testFuzz_SolvencyAllTransitions(uint256 _seed) external {
        TestMode testMode = TestMode(rnd.randInt(2));
        runTests(_seed, testMode);
    }

    function transitionRandomCoreProtocolStaking() internal {
        uint256 amountOfUseres = rnd.randInt(MAX_USERS_TO_STAKING);
        for (uint256 i = 0; i < amountOfUseres; i++) {
            address randomUser = rnd.randAddress();
            uint256 amount = rnd.randAmountD18();
            deal(randomUser, amount);
            vm.prank(randomUser);
            lido.stake{value: amount}();
        }
    }

    function transitionRandomCoreProtocolReceiveReward() internal {
        uint256 dailyReward = rewardSimulatorForCoreProtocol.getDailyReward();
        if (dailyReward > 0) {
            console2.log("Receive reward for core protocol", dailyReward);
            lido.receiveRewards(dailyReward);
        }
    }

    function transitionVaultRandomReceiveReward(StakingVault _stakingVault) internal {
        uint256 dailyReward = rewardSimulatorForValidator.getDailyReward();
        if (dailyReward > 0) {
            vm.deal(address(_stakingVault), address(_stakingVault).balance + dailyReward);
            console2.log("Receive random reward", address(_stakingVault), dailyReward);
        }
    }

    function transitionVaultRandomPenalty(StakingVault _stakingVault) internal {
        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_stakingVault));

        uint256 valuationThreshold = (_stakingVault.valuation() * (TOTAL_BASIS_POINTS - socket.rebalanceThresholdBP)) /
            TOTAL_BASIS_POINTS;
        if (valuationThreshold < lido.getPooledEthByShares(socket.sharesMinted)) {
            console2.log("Cannot apply penalty");
            return;
        }
        uint256 maxPenalty = valuationThreshold - lido.getPooledEthByShares(socket.sharesMinted);
        uint256 penalty = rnd.randInt(maxPenalty);

        vm.deal(address(_stakingVault), address(_stakingVault).balance - penalty);
    }

    function transitionRandomMint(StakingVault _stakingVault) internal {
        uint256 totalShares = lido.getTotalShares();
        uint256 totalPooledEther = lido.getTotalPooledEther();

        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_stakingVault));

        uint256 sharesLimitedByShareLimit = socket.shareLimit - socket.sharesMinted;
        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - socket.reserveRatioBP;

        uint256 sharesLimitedByValuation = 0;
        uint256 maxSharesLimitedByValuation = (_stakingVault.valuation() * totalShares * maxMintableRatioBP) /
            (totalPooledEther * TOTAL_BASIS_POINTS);
        if (maxSharesLimitedByValuation > socket.sharesMinted) {
            sharesLimitedByValuation = maxSharesLimitedByValuation - socket.sharesMinted;
        }
        uint256 sharesLimit = Math256.min(sharesLimitedByShareLimit, sharesLimitedByValuation);

        uint256 sharesLimitedByLocked = 0;
        uint256 maxSharesLimitedByLocked = (_stakingVault.locked() * totalShares * maxMintableRatioBP) /
            (totalPooledEther * TOTAL_BASIS_POINTS);
        if (maxSharesLimitedByLocked > socket.sharesMinted) {
            sharesLimitedByLocked = maxSharesLimitedByLocked - socket.sharesMinted;
        }

        sharesLimit = Math256.min(sharesLimit, sharesLimitedByLocked);

        uint256 amountOfSharesToMint = rnd.randInt(sharesLimit);

        if (amountOfSharesToMint == 0) {
            return;
        }

        vm.prank(owner);
        vaultHubProxy.mintShares(address(_stakingVault), address(owner), amountOfSharesToMint);
        console2.log("Mint random shares", address(_stakingVault), amountOfSharesToMint);

        totalSharesMinted += amountOfSharesToMint;
    }

    function transitionRandomBurn(StakingVault _stakingVault) internal {
        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_stakingVault));
        uint256 amountOfSharesToBurn = rnd.randAmountD18();
        if (amountOfSharesToBurn > 0 && amountOfSharesToBurn <= socket.sharesMinted) {
            console2.log("Burn random shares", address(_stakingVault), amountOfSharesToBurn);
            vm.prank(owner);
            vaultHubProxy.burnShares(address(_stakingVault), amountOfSharesToBurn);
            totalSharesBurned += amountOfSharesToBurn;
        }
    }

    function transitionRandomRebalance(StakingVault _stakingVault) internal {
        if (!vaultHubProxy.isVaultHealthyAsOfLatestReport(address(_stakingVault))) {
            console2.log("Rebalance", address(_stakingVault));
            uint256 rebalanceShortfall = vaultHubProxy.rebalanceShortfall(address(_stakingVault));
            uint256 sharesToBurn = lido.getSharesByPooledEth(rebalanceShortfall);
            totalSharesBurned += sharesToBurn;
            vm.prank(owner);
            vaultHubProxy.forceRebalance(address(_stakingVault));
        }
    }

    function getVaultState(Vault memory _vault) internal view returns (VaultState) {
        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_vault.stakingVaultProxy));

        if (
            lido.getPooledEthByShares(socket.sharesMinted) <=
            (_vault.stakingVaultProxy.valuation() * (TOTAL_BASIS_POINTS - socket.reserveRatioBP)) / TOTAL_BASIS_POINTS
        ) {
            return VaultState.MintingAllowed;
        } else if (
            lido.getPooledEthByShares(socket.sharesMinted) <=
            (_vault.stakingVaultProxy.valuation() * (TOTAL_BASIS_POINTS - socket.rebalanceThresholdBP)) /
                TOTAL_BASIS_POINTS
        ) {
            return VaultState.Healthy;
        } else if (lido.getPooledEthByShares(socket.sharesMinted) <= _vault.stakingVaultProxy.valuation()) {
            return VaultState.Unhealthy;
        } else {
            return VaultState.BadDebt;
        }
    }

    function printVaultState(Vault memory _vault) internal {
        VaultState state = getVaultState(_vault);

        if (state == VaultState.MintingAllowed) {
            console2.log("vaultShares_in_ETH <= 0.90", address(_vault.stakingVaultProxy));
        } else if (state == VaultState.Healthy) {
            console2.log("0.90 < vaultShares_in_ETH <= 0.92", address(_vault.stakingVaultProxy));
        } else if (state == VaultState.Unhealthy) {
            console2.log("0.92 < vaultShares_in_ETH <= 1.00", address(_vault.stakingVaultProxy));
        } else {
            console2.log("vaultShares_in_ETH > 1.00", address(_vault.stakingVaultProxy));
        }
    }
}
