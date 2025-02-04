// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {StakingRouter} from "contracts/0.8.9/StakingRouter.sol";

contract StakingRouter__MockForLidoAccountingFuzzing {
    event Mock__MintedRewardsReported();
    event Mock__MintedTotalShares(uint256 indexed _totalShares);

    address[] private recipients__mocked;
    uint256[] private stakingModuleIds__mocked;
    uint96[] private stakingModuleFees__mocked;
    uint96 private totalFee__mocked;
    uint256 private precisionPoint__mocked;

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
        stakingModuleIds = stakingModuleIds__mocked;
        stakingModuleFees = stakingModuleFees__mocked;
        totalFee = totalFee__mocked;
        precisionPoints = precisionPoint__mocked;
    }

    function reportRewardsMinted(uint256[] calldata _stakingModuleIds, uint256[] calldata _totalShares) external {
        emit Mock__MintedRewardsReported();

        uint256 totalShares = 0;
        for (uint256 i = 0; i < _totalShares.length; i++) {
            totalShares += _totalShares[i];
        }

        emit Mock__MintedTotalShares(totalShares);
    }

    function mock__getStakingRewardsDistribution(
        address[] calldata _recipients,
        uint256[] calldata _stakingModuleIds,
        uint96[] calldata _stakingModuleFees,
        uint96 _totalFee,
        uint256 _precisionPoints
    ) external {
        recipients__mocked = _recipients;
        stakingModuleIds__mocked = _stakingModuleIds;
        stakingModuleFees__mocked = _stakingModuleFees;
        totalFee__mocked = _totalFee;
        precisionPoint__mocked = _precisionPoints;
    }

    function getStakingModuleIds() public view returns (uint256[] memory) {
        return stakingModuleIds__mocked;
    }

    function getRecipients() public view returns (address[] memory) {
        return recipients__mocked;
    }

    function getStakingModule(uint256 _stakingModuleId) public view returns (StakingRouter.StakingModule memory) {
        if (_stakingModuleId >= 4) {
            revert("Staking module does not exist");
        }

        if (_stakingModuleId == 1) {
            return
                StakingRouter.StakingModule({
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
        }

        if (_stakingModuleId == 2) {
            return
                StakingRouter.StakingModule({
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
        }

        if (_stakingModuleId == 3) {
            return
                StakingRouter.StakingModule({
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
        }
    }
}
