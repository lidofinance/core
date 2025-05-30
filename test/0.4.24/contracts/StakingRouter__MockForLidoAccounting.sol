// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

contract StakingRouter__MockForLidoAccounting {
    event Mock__MintedRewardsReported();

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

    function reportRewardsMinted(uint256[] calldata, uint256[] calldata) external {
        emit Mock__MintedRewardsReported();
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
}
