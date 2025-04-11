// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

import {Test} from "forge-std/Test.sol";
import {VaultHub} from "contracts/0.8.25/vaults/VaultHub.sol";
import {StakingVault} from "contracts/0.8.25/vaults/StakingVault.sol";
import {RandomLib} from "./RandomLib.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts-v5.2/proxy/ERC1967/ERC1967Proxy.sol";
import {ILidoLocator} from "contracts/common/interfaces/ILidoLocator.sol";
import {ILido} from "contracts/0.8.25/interfaces/ILido.sol";
import {DepositContract__MockForStakingVault} from "./contracts/DepositContract__MockForStakingVault.sol";
import {console2} from "forge-std/console2.sol";
import {Math256} from "contracts/common/lib/Math256.sol";

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
        return 100;
    }

    function transferShares(address, uint256) external returns (uint256) {
        return 100;
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

contract ValidatorMock is Test {
    using RandomLib for RandomLib.Storage;

    uint256 constant SECONDS_PER_DAY = 86400;
    uint256 constant APR_DENOMINATOR = 10000;
    uint256 constant DAYS_PER_YEAR = 365;
    uint256 constant APR_MIN = 300; // 3.00% minimum APR
    uint256 constant APR_MAX = 500; // 5.00% maximum APR
    uint256 constant MIN_VALIDATOR_BALANCE = 32 ether;

    uint256 private currentAPR;
    uint256 private lastRewardTimestamp;

    RandomLib.Storage private rnd;

    constructor(uint256 _seed) {
        rnd.seed = _seed;
        lastRewardTimestamp = block.timestamp;
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
    RandomLib.Storage private rnd;

    VaultHub vaultHubProxy;
    LidoMock lido;
    DepositContract__MockForStakingVault depositContract;
    ValidatorMock validator;

    address owner = makeAddr("owner");
    address predepositGuarantee = makeAddr("predepositGuarantee");
    address accounting = makeAddr("accounting");
    address treasury = makeAddr("treasury");
    address depositor = makeAddr("depositor");
    address nodeOperator = makeAddr("nodeOperator");

    uint256 private ITERATIONS = 100;
    uint256 private CONNECTED_VAULTS_LIMIT = 100;
    uint256 private BAD_BEHAVIOUR_ITERATIONS_LIMIT = 10;
    uint256 private VALIDATOR_PENALTY_SANITEL = 666;
    uint256 internal constant TOTAL_BASIS_POINTS = 100_00;
    uint256 internal constant SECONDS_PER_DAY = 86400;

    struct Vault {
        StakingVault stakingVaultProxy;
        bool isValidatorPerformingWell;
        bool isMinted;
        uint256 referenceValuation;
        uint256 lifetime;
        uint256 badBehaviourIterations;
    }

    enum RandomAction {
        Mint,
        Burn,
        Rebalance,
        ReceiveReward,
        Penalty
    }

    Vault[] private vaults;

    function deploy(uint256 _seed) public {
        rnd.seed = _seed;

        depositContract = new DepositContract__MockForStakingVault();

        lido = new LidoMock(7810237 * 10 ** 18, 9365361 * 10 ** 18, 0);
        LidoLocatorMock locator = new LidoLocatorMock(depositor, accounting, treasury);
        VaultHub vaultHub = new VaultHub(locator, lido, CONNECTED_VAULTS_LIMIT, 1000);

        ERC1967Proxy proxy = new ERC1967Proxy(
            address(vaultHub),
            abi.encodeWithSelector(VaultHub.initialize.selector, owner)
        );

        vaultHubProxy = VaultHub(payable(address(proxy)));
        bytes32 adminRole = vaultHubProxy.getRoleAdmin(vaultHubProxy.DEFAULT_ADMIN_ROLE());
        console2.logBytes32(adminRole);
        console2.log(vaultHubProxy.hasRole(adminRole, owner));
        console2.log("owner", owner);

        bytes32 vaultMasterRole = vaultHubProxy.VAULT_MASTER_ROLE();
        vm.prank(owner);
        vaultHubProxy.grantRole(vaultMasterRole, owner);

        bytes32 vaultRegistryRole = vaultHubProxy.VAULT_REGISTRY_ROLE();
        vm.prank(owner);
        vaultHubProxy.grantRole(vaultRegistryRole, owner);
    }

    function createAndConnectVault() internal {
        StakingVault stakingVault = new StakingVault(address(vaultHubProxy), depositor, address(depositContract));
        ERC1967Proxy proxy = new ERC1967Proxy(
            address(stakingVault),
            abi.encodeWithSelector(StakingVault.initialize.selector, owner, nodeOperator, "0x")
        );
        StakingVault stakingVaultProxy = StakingVault(payable(address(proxy)));

        Vault memory vault = Vault({
            stakingVaultProxy: stakingVaultProxy,
            isValidatorPerformingWell: rnd.randBool(),
            isMinted: false,
            referenceValuation: stakingVaultProxy.valuation(),
            lifetime: rnd.randInt(ITERATIONS / 2),
            badBehaviourIterations: 0
        });
        vaults.push(vault);

        vm.prank(owner);
        vaultHubProxy.addVaultProxyCodehash(address(stakingVaultProxy).codehash);

        deal(address(owner), 32 ether);
        vm.prank(owner);
        stakingVaultProxy.fund{value: 32 ether}();

        vm.prank(owner);
        vaultHubProxy.connectVault(address(stakingVaultProxy), 10 ** 18, 1000, 800, 500);
    }

    function runTests(uint256 _seed) internal {
        deploy(_seed);

        validator = new ValidatorMock(_seed);
        createAndConnectVault();

        for (uint256 iterationIdx = 0; iterationIdx < ITERATIONS; iterationIdx++) {
            vm.warp(block.timestamp + SECONDS_PER_DAY);

            removeAndDisconnectDeadVault(vaults);
            performRandomActions(vaults);

            transitionRandomCoreProtocolStaking();
            transitionRandomCoreProtocolReceiveReward();

            updateVaults(vaults);

            for (uint256 i = 0; i < vaults.length; i++) {
                Vault storage vault = vaults[i];
                VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy));
                assertTrue(
                    lido.getPooledEthBySharesRoundUp(socket.sharesMinted) <= vault.stakingVaultProxy.valuation()
                );
            }
        }
    }

    // LIDO protocol has a simplified model not considering withdrawals, elRewards, MEV and tips.
    function updateVaults(Vault[] memory _vaults) internal {
        uint256[] memory vaultsValuations = new uint256[](_vaults.length);
        int256[] memory inOutDeltas = new int256[](_vaults.length);
        uint256[] memory treasureFeeShares = new uint256[](_vaults.length);
        uint256[] memory locked = new uint256[](_vaults.length);

        for (uint256 i = 0; i < _vaults.length; i++) {
            vaultsValuations[i] = address(_vaults[i].stakingVaultProxy).balance;
            inOutDeltas[i] = _vaults[i].stakingVaultProxy.inOutDelta();
        }

        uint256 preTotalShares = lido.getTotalShares();
        uint256 preTotalPooledEther = lido.getTotalPooledEther();
        uint256 preExternalShares = lido.getExternalShares();
        uint256 preExternalEther = lido.getExternalEther();

        uint256 postInternalSharesBeforeFees = preTotalShares - preExternalShares;
        uint256 sharesToMintAsFees = 0;
        uint256 postInternalShares = postInternalSharesBeforeFees + sharesToMintAsFees; // omit shares to be burned for withdrawals and cover
        uint256 postInternalEther = preTotalPooledEther - preExternalEther; // omit total cl rewards (or penalty) + MEV and tips + withdrawals

        (uint256[] memory lockedEther, uint256[] memory vaultsFeeShares, ) = vaultHubProxy.calculateVaultsRebase(
            vaultsValuations,
            preTotalShares,
            preTotalPooledEther,
            postInternalShares,
            postInternalEther,
            sharesToMintAsFees
        );

        vm.prank(accounting);
        vaultHubProxy.updateVaults(vaultsValuations, inOutDeltas, lockedEther, vaultsFeeShares);

        console2.log("updateVaults");
    }

    function removeAndDisconnectDeadVault(Vault[] storage _vaults) internal {
        for (uint256 i = _vaults.length; i > 0; i--) {
            if (_vaults[i - 1].lifetime == 0) {
                for (uint256 j = i - 1; j < _vaults.length - 1; j++) {
                    _vaults[j] = _vaults[j + 1];
                }
                Vault memory vault = _vaults[_vaults.length - 1];

                VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy));
                if (socket.sharesMinted > 0) {
                    vm.prank(owner);
                    vaultHubProxy.burnShares(address(vault.stakingVaultProxy), socket.sharesMinted);
                }

                vm.prank(owner);
                vaultHubProxy.disconnect(address(vault.stakingVaultProxy));
                _vaults.pop();

                console2.log("Removed vault");
            }
        }
    }

    function performRandomActions(Vault[] storage _vaults) internal {
        for (uint256 i = 0; i < _vaults.length; i++) {
            Vault storage vault = _vaults[i];
            vault.lifetime--;

            VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(vault.stakingVaultProxy));
            printVaultState(vault);

            RandomAction action = RandomAction(rnd.randInt(2));
            if (action == RandomAction.Mint) {
                transitionRandomMint(vault.stakingVaultProxy);
            }

            if (vault.badBehaviourIterations == VALIDATOR_PENALTY_SANITEL) {
                continue;
            }

            if (getVaultState(vault) == VaultState.Unhealthy) {
                vault.badBehaviourIterations++;
            }

            if (vault.badBehaviourIterations > BAD_BEHAVIOUR_ITERATIONS_LIMIT) {
                vault.badBehaviourIterations = VALIDATOR_PENALTY_SANITEL;
            } else {
                transitionVaultRandomPenalty(vault.stakingVaultProxy);
            }
        }
    }

    function testSolvencyAllTransitions() external {
        runTests(5686631772487049791906286);
    }

    function testFuzz_SolvencyAllTransitions(uint256 _seed) external {
        runTests(_seed);
    }

    function transitionRandomCoreProtocolStaking() internal {
        uint256 amountOfUseres = rnd.randInt(100);
        for (uint256 i = 0; i < amountOfUseres; i++) {
            address randomUser = rnd.randAddress();
            uint256 amount = rnd.randAmountD18();
            deal(randomUser, amount);
            vm.prank(randomUser);
            lido.stake{value: amount}();
        }
    }

    function transitionRandomCoreProtocolReceiveReward() internal {
        uint256 APR_MIN = 300; // 3.00%
        uint256 APR_MAX = 400; // 4.00%
        uint256 APR_DENOMINATOR = 10000;
        uint256 DAYS_PER_YEAR = 365;

        uint256 totalPooledEther = lido.getTotalPooledEther();
        uint256 currentAPR = APR_MIN + rnd.randInt(APR_MAX - APR_MIN);
        uint256 yearlyReward = (totalPooledEther * currentAPR) / APR_DENOMINATOR;
        uint256 dailyReward = yearlyReward / DAYS_PER_YEAR;
        int256 randomVariation = int256(rnd.randInt(200)) - 100; // -100 to +100
        dailyReward = uint256((int256(dailyReward) * (1000 + randomVariation)) / 1000);

        if (dailyReward > 0) {
            lido.receiveRewards(dailyReward);
        }
    }

    function transitionVaultRandomReceiveReward(StakingVault _stakingVault) internal {
        uint256 dailyReward = validator.getDailyReward();
        console2.log("Receive random reward", dailyReward);
        uint256 valuationBefore = _stakingVault.valuation();
        uint256 balanceBefore = address(_stakingVault).balance;

        vm.deal(address(_stakingVault), address(_stakingVault).balance + dailyReward);
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
        console2.log("Penalty", penalty);

        vm.deal(address(_stakingVault), address(_stakingVault).balance - penalty);
    }

    function transitionRandomMint(StakingVault _stakingVault) internal {
        uint256 totalShares = lido.getTotalShares();
        uint256 totalPooledEther = lido.getTotalPooledEther();

        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_stakingVault));

        uint256 sharesLimit01 = socket.shareLimit - socket.sharesMinted;
        uint256 sharesLimit02 = 0;
        uint256 share = (_stakingVault.valuation() * (TOTAL_BASIS_POINTS - socket.reserveRatioBP) * totalShares) /
            (TOTAL_BASIS_POINTS * totalPooledEther);
        if (share > socket.sharesMinted) {
            sharesLimit02 = share - socket.sharesMinted;
        }
        uint256 sharesLimit = Math256.min(sharesLimit01, sharesLimit02);
        uint256 amountOfSharesToMint = rnd.randAmountD18();
        if (amountOfSharesToMint > sharesLimit) {
            amountOfSharesToMint = sharesLimit;
        }

        if (amountOfSharesToMint == 0) {
            return;
        }

        console2.log("Mint random shares", amountOfSharesToMint);

        vm.prank(owner);
        vaultHubProxy.mintShares(address(_stakingVault), address(owner), amountOfSharesToMint);
    }

    function transitionRandomBurn(StakingVault _stakingVault) internal {
        VaultHub.VaultSocket memory socket = vaultHubProxy.vaultSocket(address(_stakingVault));
        uint256 amountOfSharesToBurn = rnd.randAmountD18();
        if (amountOfSharesToBurn > 0 && amountOfSharesToBurn <= socket.sharesMinted) {
            console2.log("Burn random shares", amountOfSharesToBurn);
            vm.prank(owner);
            vaultHubProxy.burnShares(address(_stakingVault), amountOfSharesToBurn);
        }
    }

    function transitionRandomRebalance(StakingVault _stakingVault) internal {
        console2.log("Rebalance");
        if (!vaultHubProxy.isVaultHealthy(address(_stakingVault))) {
            vm.prank(owner);
            vaultHubProxy.forceRebalance(address(_stakingVault));
        }
    }

    enum VaultState {
        MintingAllowed, // Shares(inEth) <= 0.90
        Healthy, // 0.90  < Shares(inEth) <= 0.92
        Unhealthy, // 0.92 < Shares(inEth) < 1.00
        BadDebt // Shares(inEth) >= 1.00
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
            console2.log("Shares(inEth) <= 0.90");
        } else if (state == VaultState.Healthy) {
            console2.log("0.90  < Shares(inEth) <= 0.92");
        } else if (state == VaultState.Unhealthy) {
            console2.log("0.92 < Shares(inEth) < 1.00");
        } else {
            console2.log("Shares(inEth) >= 1.00");
        }
    }
}
