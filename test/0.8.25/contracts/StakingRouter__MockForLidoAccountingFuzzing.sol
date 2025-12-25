// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

interface IStakingRouter {
    struct StakingModule {
        uint256 id;
        address stakingModuleAddress;
        uint96 stakingModuleFee;
        uint96 treasuryFee;
        uint256 stakeShareLimit;
        uint256 status;
        string name;
        uint256 lastDepositAt;
        uint256 lastDepositBlock;
        uint256 exitedValidatorsCount;
        uint256 priorityExitShareThreshold;
        uint256 maxDepositsPerBlock;
        uint256 minDepositBlockDistance;
    }
}

contract StakingRouter__MockForLidoAccountingFuzzing {
    event Mock__MintedRewardsReported();
    event Mock__MintedTotalShares(uint256 indexed _totalShares);

    address[] private recipients__mocked;
    uint96[] private stakingModuleFees__mocked;
    uint96 private totalFee__mocked;
    uint256 private precisionPoint__mocked;

    mapping(uint256 => IStakingRouter.StakingModule) private stakingModules;
    uint256[] private stakingModulesIds;

    constructor() {
        stakingModules[1] = IStakingRouter.StakingModule({
            id: 1,
            stakingModuleAddress: 0x55032650b14df07b85bF18A3a3eC8E0Af2e028d5,
            stakingModuleFee: 500,
            treasuryFee: 500,
            stakeShareLimit: 10000,
            status: 0,
            name: "curated-onchain-v1",
            lastDepositAt: 1732694279,
            lastDepositBlock: 21277744,
            exitedValidatorsCount: 88207,
            priorityExitShareThreshold: 10000,
            maxDepositsPerBlock: 150,
            minDepositBlockDistance: 25
        });

        stakingModulesIds.push(1);

        stakingModules[2] = IStakingRouter.StakingModule({
            id: 2,
            stakingModuleAddress: 0xaE7B191A31f627b4eB1d4DaC64eaB9976995b433,
            stakingModuleFee: 800,
            treasuryFee: 200,
            stakeShareLimit: 400,
            status: 0,
            name: "SimpleDVT",
            lastDepositAt: 1735217831,
            lastDepositBlock: 21486781,
            exitedValidatorsCount: 5,
            priorityExitShareThreshold: 444,
            maxDepositsPerBlock: 150,
            minDepositBlockDistance: 25
        });
        stakingModulesIds.push(2);

        stakingModules[3] = IStakingRouter.StakingModule({
            id: 3,
            stakingModuleAddress: 0xdA7dE2ECdDfccC6c3AF10108Db212ACBBf9EA83F,
            stakingModuleFee: 600,
            treasuryFee: 400,
            stakeShareLimit: 100,
            status: 0,
            name: "Community Staking",
            lastDepositAt: 1735217387,
            lastDepositBlock: 21486745,
            exitedValidatorsCount: 104,
            priorityExitShareThreshold: 125,
            maxDepositsPerBlock: 30,
            minDepositBlockDistance: 25
        });

        stakingModulesIds.push(3);
    }

    function getStakingRewardsDistribution()
        public
        view
        returns (
            address[] memory recipients,
            uint256[] memory stakingModuleIds,
            uint96[] memory stakingModuleFees,
            uint96 totalFee,
            uint256 precisionPoints
        )
    {
        recipients = recipients__mocked;
        stakingModuleFees = stakingModuleFees__mocked;
        stakingModuleIds = stakingModulesIds;
        totalFee = totalFee__mocked;
        precisionPoints = precisionPoint__mocked;
    }

    function reportRewardsMinted(uint256[] calldata, uint256[] calldata _totalShares) external {
        emit Mock__MintedRewardsReported();

        uint256 totalShares = 0;
        for (uint256 i = 0; i < _totalShares.length; i++) {
            totalShares += _totalShares[i];
        }

        emit Mock__MintedTotalShares(totalShares);
    }

    function mock__getStakingRewardsDistribution(
        address[] calldata _recipients,
        uint96[] calldata _stakingModuleFees,
        uint96 _totalFee,
        uint256 _precisionPoints
    ) external {
        recipients__mocked = _recipients;
        stakingModuleFees__mocked = _stakingModuleFees;
        totalFee__mocked = _totalFee;
        precisionPoint__mocked = _precisionPoints;
    }

    function getStakingModuleIds() public view returns (uint256[] memory) {
        return stakingModulesIds;
    }

    function getRecipients() public view returns (address[] memory) {
        return recipients__mocked;
    }

    function getStakingModule(
        uint256 _stakingModuleId
    ) public view returns (IStakingRouter.StakingModule memory stakingModule) {
        if (_stakingModuleId >= 4) {
            revert("Staking module does not exist");
        }

        return stakingModules[_stakingModuleId];
    }
}
