// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {OperatorGrid} from "contracts/0.8.25/vaults/OperatorGrid.sol";
import {Math256} from "contracts/common/lib/Math256.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {RandomLib} from "./RandomLib.sol";
import {RewardSimulator} from "./RewardSimulator.sol";

contract OperatorGridMock {
    uint256 public shareLimit;
    uint256 public reserveRatioBP;
    uint256 public forcedRebalanceThresholdBP;
    uint256 public infraFeeBP;
    uint256 public liquidityFeeBP;
    uint256 public reservationFeeBP;

    constructor(
        uint256 _shareLimit,
        uint256 _reserveRatioBP,
        uint256 _forcedRebalanceThresholdBP,
        uint256 _infraFeeBP,
        uint256 _liquidityFeeBP,
        uint256 _reservationFeeBP
    ) {
        shareLimit = _shareLimit;
        reserveRatioBP = _reserveRatioBP;
        forcedRebalanceThresholdBP = _forcedRebalanceThresholdBP;
        infraFeeBP = _infraFeeBP;
        liquidityFeeBP = _liquidityFeeBP;
        reservationFeeBP = _reservationFeeBP;
    }

    function vaultInfo(
        address
    ) external view returns (address, uint256, uint256, uint256, uint256, uint256, uint256, uint256) {
        return (
            address(0),
            0,
            shareLimit,
            reserveRatioBP,
            forcedRebalanceThresholdBP,
            infraFeeBP,
            liquidityFeeBP,
            reservationFeeBP
        );
    }

    function onMintedShares(address, uint256) external pure {
        return;
    }

    function onBurnedShares(address, uint256) external pure {
        return;
    }
}

contract LidoLocatorMock {
    address public predepositGuarantee_;
    address public accounting_;
    address public treasury_;
    address public operatorGrid_;
    address public lazyOracle_;

    constructor(
        address _predepositGuarantee,
        address _accounting,
        address _treasury,
        address _operatorGrid,
        address _lazyOracle
    ) {
        predepositGuarantee_ = _predepositGuarantee;
        accounting_ = _accounting;
        treasury_ = _treasury;
        operatorGrid_ = _operatorGrid;
        lazyOracle_ = _lazyOracle;
    }

    function operatorGrid() external view returns (address) {
        return operatorGrid_;
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

    function lazyOracle() external view returns (address) {
        return lazyOracle_;
    }
}

contract LazyOracleMock {
    uint256 public latestReportTimestamp_;

    constructor(uint256 _latestReportTimestamp) {
        latestReportTimestamp_ = _latestReportTimestamp;
    }

    function setLatestReportTimestamp(uint256 _latestReportTimestamp) external {
        latestReportTimestamp_ = _latestReportTimestamp;
    }

    function latestReportTimestamp() external view returns (uint256) {
        return latestReportTimestamp_;
    }
}

contract LidoMock {
    uint256 public totalShares;
    uint256 public externalShares;
    uint256 public totalPooledEther;
    uint256 public bufferedEther;

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

    function mintExternalShares(address, uint256 _amountOfShares) external {
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
        uint256 etherAmount = (_sharesAmount * totalPooledEther) / totalShares;
        if (_sharesAmount * totalPooledEther != etherAmount * totalShares) {
            ++etherAmount;
        }
        return etherAmount;
    }

    function transferSharesFrom(address, address, uint256) external pure returns (uint256) {
        return 0;
    }

    function getTotalPooledEther() external view returns (uint256) {
        return totalPooledEther;
    }

    function mintShares(address, uint256 _sharesAmount) external {
        totalShares += _sharesAmount;
    }

    function burnShares(uint256 _amountOfShares) external {
        totalShares -= _amountOfShares;
    }
}

contract VaultHubTest is Test {
    using RandomLib for RandomLib.Storage;

    struct Vault {
        StakingVault stakingVaultProxy;
        ValidatorState validatorState;
        uint256 lifetime;
        uint256 lastInactivePenaltyTime;
        VaultState lastState;
    }

    enum VaultState {
        MintingAllowed,
        Healthy,
        Unhealthy,
        BadDebt,
        Unknown
    }

    enum ValidatorState {
        Active,
        Inactive,
        Slashed
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
    OperatorGridMock operatorGrid;
    LazyOracleMock lazyOracle;

    address private owner = makeAddr("owner");
    address private predepositGuarantee = makeAddr("predepositGuarantee");
    address private accounting = makeAddr("accounting");
    address private treasury = makeAddr("treasury");
    address private depositor = makeAddr("depositor");
    address private nodeOperator = makeAddr("nodeOperator");

    RandomLib.Storage private rnd;

    uint256 internal constant ITERATIONS = 170;
    uint256 internal constant CONNECTED_VAULTS_LIMIT = 100;
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    uint256 internal constant SECONDS_PER_DAY = 86400;
    uint256 internal constant LOCKED_AMOUNT = 32 ether;
    uint256 internal constant MAX_USERS_TO_STAKING = 100;
    uint256 internal constant CHANCE_TO_CREATE_AND_CONNECT_VAULT = 10;
    uint256 internal constant CHANCE_TO_CALL_REBALANCE_OR_BURN = 10;
    uint256 internal constant CHANCE_TO_CALL_WITHDRAW = 30;

    uint256 private constant INACTIVE_PENALTY_PERIOD = 21 days;
    uint256 private constant INACTIVE_PENALTY_TOTAL_BP = 6000;
    uint256 private constant INACTIVE_PENALTY_PER_DAY_BP = INACTIVE_PENALTY_TOTAL_BP / 21;

    Vault[] private vaults;
    uint256 private totalSharesMinted;
    uint256 private totalSharesBurned;
    uint256 private connectedVaults;
    uint256 private disconnectedVaults;
    uint256 private relativeShareLimitBp;

    function deploy(uint256 _seed) public {
        rnd.seed = _seed;

        depositContract = new DepositContract__MockForStakingVault();

        relativeShareLimitBp = 2000; // 20%
        // these numbers were taken from mainnet protocol state
        lido = new LidoMock(7810237 * 10 ** 18, 9365361 * 10 ** 18, 0);

        // average validator APR is between 2.8-5.7%
        rewardSimulatorForValidator = new RewardSimulator(_seed, 280, 570, 32 ether);
        // average core protocol APR is between 2.78-3.6%
        rewardSimulatorForCoreProtocol = new RewardSimulator(_seed, 278, 360, lido.getTotalPooledEther());

        uint256 shareLimit = 35 ether + rnd.randInt(5) * 1 ether; // between 35 and 40 ETH
        uint256 reserveRatioBp = 1000 + rnd.randInt(1000); // between 10% and 20%
        uint256 forcedRebalanceThresholdBp = 500 + rnd.randInt(reserveRatioBp - 500); // between 5% and 95% of reserveRatioBp
        uint256 infraFeeBp = 500 + rnd.randInt(500); // between 5% and 10%
        uint256 liquidityFeeBp = 500 + rnd.randInt(500); // between 5% and 10%
        uint256 reservationFeeBp = 500 + rnd.randInt(500); // between 5% and 10%
        operatorGrid = new OperatorGridMock(
            shareLimit,
            reserveRatioBp,
            forcedRebalanceThresholdBp,
            infraFeeBp,
            liquidityFeeBp,
            reservationFeeBp
        );

        lazyOracle = new LazyOracleMock(block.timestamp);
        LidoLocatorMock lidoLocator = new LidoLocatorMock(
            depositor,
            accounting,
            treasury,
            address(operatorGrid),
            address(lazyOracle)
        );
        VaultHub vaultHub = new VaultHub(
            ILidoLocator(address(lidoLocator)),
            ILido(address(lido)),
            relativeShareLimitBp
        );
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(vaultHub),
            abi.encodeWithSelector(VaultHub.initialize.selector, owner)
        );
        vaultHubProxy = VaultHub(payable(address(proxy)));

        bytes32 vaultMasterRole = vaultHubProxy.VAULT_MASTER_ROLE();
        vm.prank(owner);
        vaultHubProxy.grantRole(vaultMasterRole, owner);

        bytes32 vaultCodehashSetRole = vaultHubProxy.VAULT_CODEHASH_SET_ROLE();
        vm.prank(owner);
        vaultHubProxy.grantRole(vaultCodehashSetRole, owner);
    }

    function createAndConnectVault(bool _addCodehash, TestMode _testMode) internal {
        StakingVault stakingVault = new StakingVault(address(depositContract));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, owner, nodeOperator, depositor, "0x")
        );
        StakingVault stakingVaultProxy = StakingVault(payable(address(proxy)));

        if (_addCodehash) {
            vm.prank(owner);
            vaultHubProxy.setAllowedCodehash(address(stakingVaultProxy).codehash, true);
        }

        deal(address(owner), LOCKED_AMOUNT);
        vm.prank(owner);
        stakingVaultProxy.fund{value: LOCKED_AMOUNT}();

        vm.prank(owner);
        stakingVaultProxy.transferOwnership(address(vaultHubProxy));

        vm.prank(owner);
        vaultHubProxy.connectVault(address(stakingVaultProxy));

        ValidatorState validatorState;
        if (_testMode == TestMode.BadPerformingValidators) {
            validatorState = rnd.randBool() ? ValidatorState.Inactive : ValidatorState.Slashed;
        } else if (_testMode == TestMode.WellPerformingValidators) {
            validatorState = ValidatorState.Active;
        } else if (_testMode == TestMode.All) {
            validatorState = ValidatorState(rnd.randInt(2));
        }

        Vault memory vault = Vault({
            stakingVaultProxy: stakingVaultProxy,
            lifetime: rnd.randInt(ITERATIONS / 2),
            lastInactivePenaltyTime: 0,
            validatorState: validatorState,
            lastState: VaultState.Unknown
        });
        vaults.push(vault);

        console2.log("Creating and connecting vault", address(stakingVaultProxy));

        connectedVaults++;
    }

    function runTests(uint256 _seed, TestMode _testMode) internal {
        deploy(_seed);

        createAndConnectVault(true, _testMode);

        for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
            if (vaults.length < CONNECTED_VAULTS_LIMIT && rnd.randInt(100) < CHANCE_TO_CREATE_AND_CONNECT_VAULT) {
                createAndConnectVault(false, _testMode);
            }
            updateReportAndVaultData();

            doRandomActions();

            transitionRandomCoreProtocolStaking();
            transitionRandomCoreProtocolReceiveReward();
            removeAndDisconnectDeadVault();

            if (rnd.randInt(100) >= 20) {
                vm.warp(block.timestamp + SECONDS_PER_DAY);
            } else {
                vm.warp(block.timestamp + SECONDS_PER_DAY * 2);
            }

            checkVaultsForShareLimits();
        }

        assertEq(connectedVaults, disconnectedVaults + vaults.length);

        uint256 sharesLeftover = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            Vault memory vault = vaults[i];
            sharesLeftover += vaultHubProxy.vaultRecord(address(vault.stakingVaultProxy)).liabilityShares;
        }
        assertEq(totalSharesMinted, totalSharesBurned + sharesLeftover);
    }

    function padDataIfNeeded(bytes32[] memory _data) internal pure returns (bytes32[] memory) {
        if (_data.length == 1) {
            bytes32[] memory paddedData = new bytes32[](2);
            paddedData[0] = _data[0];
            paddedData[1] = bytes32(0);
            return paddedData;
        }
        return _data;
    }

    function updateReportAndVaultData() internal {
        lazyOracle.setLatestReportTimestamp(block.timestamp);
        for (uint256 i = 0; i < vaults.length; i++) {
            if (rnd.randInt(100) < 10) {
                continue;
            }

            Vault memory vault = vaults[i];
            VaultHub.VaultRecord memory vaultRecord = vaultHubProxy.vaultRecord(address(vault.stakingVaultProxy));
            uint256 valuation = address(vault.stakingVaultProxy).balance;
            int256 inOutDelta = vaultRecord.inOutDelta;
            uint256 sharesMinted = vaultRecord.liabilityShares;
            uint256 treasureFeeShares = 0;

            vm.prank(address(lazyOracle));
            vaultHubProxy.applyVaultReport(
                address(vault.stakingVaultProxy),
                uint64(block.timestamp),
                uint256(valuation),
                int256(inOutDelta),
                treasureFeeShares,
                sharesMinted
            );
        }
    }

    function checkVaultsForShareLimits() internal view {
        uint256 totalSharesMinted = 0;
        for (uint256 i = 0; i < vaults.length; i++) {
            Vault memory vault = vaults[i];
            uint256 sharesMinted = vaultHubProxy.vaultRecord(address(vault.stakingVaultProxy)).liabilityShares;
            totalSharesMinted += sharesMinted;

            if (getVaultState(vault) != VaultState.BadDebt) {
                assertLe(
                    lido.getPooledEthBySharesRoundUp(sharesMinted),
                    vaultHubProxy.totalValue(address(vault.stakingVaultProxy))
                );
            }
        }
        uint256 relativeMaxShareLimitPerVault = (lido.getTotalShares() * relativeShareLimitBp) / TOTAL_BASIS_POINTS;
        assertLe(totalSharesMinted, relativeMaxShareLimitPerVault);
    }

    function disconnectVault(Vault memory _vault) internal {
        VaultHub.VaultRecord memory record = vaultHubProxy.vaultRecord(address(_vault.stakingVaultProxy));
        if (record.liabilityShares > 0) {
            vm.prank(owner);
            vaultHubProxy.burnShares(address(_vault.stakingVaultProxy), record.liabilityShares);
            totalSharesBurned += record.liabilityShares;
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
                console2.log("removeAndDisconnectDeadVault", address(vault.stakingVaultProxy));
                disconnectVault(vault);
                Vault memory lastVault = vaults[vaultsLength - 1];
                vaults[i] = lastVault;
                vaults.pop();
                vaultsLength--;
            }
        }
    }

    function doRandomActions() internal {
        for (uint256 vaultIdx = 0; vaultIdx < vaults.length; vaultIdx++) {
            Vault storage vault = vaults[vaultIdx];

            VaultState state = getVaultState(vault);
            if (state != vault.lastState) {
                printVaultState(state, vault.lastState, address(vault.stakingVaultProxy));
                vault.lastState = state;
            }

            if (state == VaultState.MintingAllowed) {
                if (rnd.randInt(100) < CHANCE_TO_CALL_WITHDRAW) {
                    transitionRandWithdraw(vault.stakingVaultProxy);
                } else {
                    transitionMintMaxAllowedShares(vault.stakingVaultProxy);
                }
            } else if (state == VaultState.Healthy) {
                if (rnd.randInt(100) < CHANCE_TO_CALL_REBALANCE_OR_BURN) {
                    transitionRandomBurn(vault.stakingVaultProxy);
                }
            } else if (state == VaultState.Unhealthy) {
                if (rnd.randBool()) {
                    transitionRandomRebalance(vault.stakingVaultProxy);
                } else {
                    transitionForceRebalance(vault.stakingVaultProxy);
                }
            } else if (getVaultState(vault) == VaultState.BadDebt) {
                // should be call rebalance but it reverts since this scenario is not supported yet
                uint256 rebalanceShortfall = vaultHubProxy.rebalanceShortfall(address(vault.stakingVaultProxy));
                assertEq(rebalanceShortfall, type(uint256).max);
                vault.lifetime = 0;
            }

            if (vault.validatorState == ValidatorState.Active) {
                transitionVaultRandomReceiveReward(vault.stakingVaultProxy);
            } else if (vault.validatorState == ValidatorState.Inactive) {
                transitionValidatorInactivePenalty(vault.stakingVaultProxy, vault);
                if (address(vault.stakingVaultProxy).balance < 16 ether) {
                    vault.lifetime = 0;
                }
            } else if (vault.validatorState == ValidatorState.Slashed) {
                transitionValidatorSlashedPenalty(vault.stakingVaultProxy);
                vault.lifetime = 0;
            }
        }
    }

    function testSolvencyAllTransitions() external {
        runTests(5686631772487049791906286, TestMode.All);
    }

    function testSolvencyBadPerformingValidators() external {
        runTests(123618273619736182376, TestMode.BadPerformingValidators);
    }

    function testSolvencyWellPerformingValidators() external {
        runTests(23172389139823, TestMode.WellPerformingValidators);
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

    function transitionValidatorInactivePenalty(StakingVault _stakingVault, Vault storage _vault) internal {
        uint256 timePassed = block.timestamp - _vault.lastInactivePenaltyTime;
        if (timePassed < SECONDS_PER_DAY) {
            return;
        }

        uint256 daysPassed = timePassed / SECONDS_PER_DAY;
        _vault.lastInactivePenaltyTime = block.timestamp;

        uint256 currentBalance = address(_stakingVault).balance;
        uint256 dailyPenalty = (currentBalance * INACTIVE_PENALTY_PER_DAY_BP * daysPassed) / TOTAL_BASIS_POINTS;
        console2.log("dailyPenalty", formatEth(dailyPenalty));

        if (currentBalance > dailyPenalty) {
            vm.deal(address(_stakingVault), currentBalance - dailyPenalty);
            console2.log("balance after penalty", formatEth(address(_stakingVault).balance));
        }
    }

    function transitionValidatorSlashedPenalty(StakingVault _stakingVault) internal {
        uint256 penalty = 1 ether;
        vm.deal(address(_stakingVault), address(_stakingVault).balance - penalty);
    }

    function transitionMintMaxAllowedShares(StakingVault _stakingVault) internal {
        if (!vaultHubProxy.isReportFresh(address(_stakingVault))) {
            return;
        }
        uint256 totalShares = lido.getTotalShares();
        uint256 totalPooledEther = lido.getTotalPooledEther();

        VaultHub.VaultConnection memory vaultConnection = vaultHubProxy.vaultConnection(address(_stakingVault));
        VaultHub.VaultRecord memory vaultRecord = vaultHubProxy.vaultRecord(address(_stakingVault));

        uint256 sharesLimitedByShareLimit = vaultConnection.shareLimit - vaultRecord.liabilityShares;
        uint256 maxMintableRatioBP = TOTAL_BASIS_POINTS - vaultConnection.reserveRatioBP;

        uint256 sharesLimitedByValuation = 0;
        uint256 maxSharesLimitedByValuation = (vaultHubProxy.totalValue(address(_stakingVault)) *
            totalShares *
            maxMintableRatioBP) / (totalPooledEther * TOTAL_BASIS_POINTS);
        if (maxSharesLimitedByValuation > vaultRecord.liabilityShares) {
            sharesLimitedByValuation = maxSharesLimitedByValuation - vaultRecord.liabilityShares;
        }
        uint256 sharesLimit = Math256.min(sharesLimitedByShareLimit, sharesLimitedByValuation);

        uint256 sharesLimitedByLocked = 0;
        uint256 maxSharesLimitedByLocked = (vaultRecord.locked * totalShares * maxMintableRatioBP) /
            (totalPooledEther * TOTAL_BASIS_POINTS);
        if (maxSharesLimitedByLocked > vaultRecord.liabilityShares) {
            sharesLimitedByLocked = maxSharesLimitedByLocked - vaultRecord.liabilityShares;
        }

        uint256 amountOfSharesToMint = Math256.min(sharesLimit, sharesLimitedByLocked);

        if (amountOfSharesToMint == 0) {
            return;
        }

        vm.prank(owner);
        vaultHubProxy.mintShares(address(_stakingVault), address(owner), amountOfSharesToMint);
        console2.log("Mint random shares", address(_stakingVault), amountOfSharesToMint);

        totalSharesMinted += amountOfSharesToMint;
    }

    function transitionRandomBurn(StakingVault _stakingVault) internal {
        VaultHub.VaultRecord memory record = vaultHubProxy.vaultRecord(address(_stakingVault));
        uint256 amountOfSharesToBurn = 0;
        uint256 random = rnd.randInt(100);
        if (random < 10) {
            // 10% chance to burn first 10% of shares
            amountOfSharesToBurn = rnd.randInt(record.liabilityShares / 10);
        } else if (random < 20) {
            // 10% chance to burn last 10% of shares
            amountOfSharesToBurn = record.liabilityShares - rnd.randInt(record.liabilityShares / 10);
        } else {
            // 80% chance to burn random amount
            amountOfSharesToBurn = rnd.randInt(record.liabilityShares);
        }

        if (amountOfSharesToBurn > 0) {
            console2.log("Burn random shares", address(_stakingVault), amountOfSharesToBurn);
            vm.prank(owner);
            vaultHubProxy.burnShares(address(_stakingVault), amountOfSharesToBurn);
            totalSharesBurned += amountOfSharesToBurn;
        }
    }

    function transitionForceRebalance(StakingVault _stakingVault) internal {
        if (vaultHubProxy.isVaultHealthy(address(_stakingVault))) {
            return;
        }
        uint256 rebalanceShortfall = vaultHubProxy.rebalanceShortfall(address(_stakingVault));
        uint256 sharesToBurn = lido.getSharesByPooledEth(rebalanceShortfall);
        totalSharesBurned += sharesToBurn;
        vm.prank(owner);
        vaultHubProxy.forceRebalance(address(_stakingVault));
        console2.log("Force rebalance sharesToBurn:", address(_stakingVault), sharesToBurn);
    }

    function transitionRandomRebalance(StakingVault _stakingVault) internal {
        if (vaultHubProxy.isVaultHealthy(address(_stakingVault))) {
            return;
        }
        uint256 rebalanceShortfall = vaultHubProxy.rebalanceShortfall(address(_stakingVault));
        uint256 rebalanceAmount = rnd.randInt(rebalanceShortfall);
        uint256 sharesToBurn = lido.getSharesByPooledEth(rebalanceAmount);
        totalSharesBurned += sharesToBurn;
        vm.prank(owner);
        vaultHubProxy.rebalance(address(_stakingVault), rebalanceAmount);
        console2.log("Rebalance sharesToBurn:", address(_stakingVault), sharesToBurn);
    }

    function transitionRandWithdraw(StakingVault _stakingVault) internal {
        if (!vaultHubProxy.isReportFresh(address(_stakingVault))) {
            return;
        }

        uint256 unlockedAmount = vaultHubProxy.unlocked(address(_stakingVault));
        uint256 withdrawAmount = rnd.randInt(unlockedAmount);
        console2.log("withdrawAmount", withdrawAmount);
        vm.prank(owner);
        console2.log("vault balance", address(_stakingVault).balance);
        vaultHubProxy.withdraw(address(_stakingVault), address(owner), withdrawAmount);
        console2.log("vault balance after", address(_stakingVault).balance);
    }

    function getVaultState(Vault memory _vault) internal view returns (VaultState) {
        VaultHub.VaultRecord memory vaultRecord = vaultHubProxy.vaultRecord(address(_vault.stakingVaultProxy));
        VaultHub.VaultConnection memory vaultConnection = vaultHubProxy.vaultConnection(
            address(_vault.stakingVaultProxy)
        );

        if (
            lido.getPooledEthByShares(vaultRecord.liabilityShares) <=
            (vaultHubProxy.totalValue(address(_vault.stakingVaultProxy)) *
                (TOTAL_BASIS_POINTS - vaultConnection.reserveRatioBP)) /
                TOTAL_BASIS_POINTS
        ) {
            return VaultState.MintingAllowed;
        } else if (
            lido.getPooledEthByShares(vaultRecord.liabilityShares) <=
            (vaultHubProxy.totalValue(address(_vault.stakingVaultProxy)) *
                (TOTAL_BASIS_POINTS - vaultConnection.forcedRebalanceThresholdBP)) /
                TOTAL_BASIS_POINTS
        ) {
            return VaultState.Healthy;
        } else if (
            lido.getPooledEthByShares(vaultRecord.liabilityShares) <=
            vaultHubProxy.totalValue(address(_vault.stakingVaultProxy))
        ) {
            return VaultState.Unhealthy;
        } else {
            return VaultState.BadDebt;
        }
    }

    function printVaultState(VaultState _state, VaultState _oldState, address _vaultAddress) internal pure {
        console2.log(
            string.concat(
                "----vaultState: ",
                getVaultStateString(_oldState),
                " -> ",
                getVaultStateString(_state),
                " ",
                vm.toString(_vaultAddress)
            )
        );
    }

    function getVaultStateString(VaultState _state) internal pure returns (string memory) {
        if (_state == VaultState.MintingAllowed) {
            return "MintingAllowed";
        } else if (_state == VaultState.Healthy) {
            return "Healthy";
        } else if (_state == VaultState.Unhealthy) {
            return "Unhealthy";
        } else if (_state == VaultState.BadDebt) {
            return "BadDebt";
        } else {
            return "Unknown";
        }
    }

    function formatEth(uint256 weiAmount) internal pure returns (string memory) {
        uint256 ether_value = weiAmount / 1e18;
        uint256 decimal_part = weiAmount % 1e18;

        uint256 decimals4 = (decimal_part / 1e14);

        if (ether_value == 0 && decimals4 == 0) {
            return string.concat(vm.toString(weiAmount), " wei");
        }

        string memory etherStr = vm.toString(ether_value);
        string memory decimalStr = vm.toString(decimals4);

        while (bytes(decimalStr).length < 4) {
            decimalStr = string.concat("0", decimalStr);
        }

        return string.concat(etherStr, ".", decimalStr, " ETH");
    }
}
