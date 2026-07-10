// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.25;

interface IStakingRouter {
    function receiveDepositableEther() external payable;
}

contract Lido__MockForStakingRouter {
    uint256 internal depositableEther__mocked;
    address public stakingRouter;
    bool internal canDeposit__mocked = true;

    event WithdrawDepositableEtherCalled(uint256 amount, uint256 depositsCount);

    constructor() payable {}

    receive() external payable {}

    function setStakingRouter(address _stakingRouter) external {
        stakingRouter = _stakingRouter;
    }

    function setDepositableEther(uint256 _depositableEther) external {
        depositableEther__mocked = _depositableEther;
    }

    function getDepositableEther() external view returns (uint256) {
        return depositableEther__mocked;
    }

    function setCanDeposit(bool _canDeposit) external {
        canDeposit__mocked = _canDeposit;
    }

    function canDeposit() external view returns (bool) {
        return canDeposit__mocked;
    }

    function withdrawDepositableEther(uint256 _amount, uint256 _depositsCount) external {
        require(msg.sender == stakingRouter, "ONLY_STAKING_ROUTER");
        require(_amount <= depositableEther__mocked, "NOT_ENOUGH_ETHER");

        depositableEther__mocked -= _amount;

        emit WithdrawDepositableEtherCalled(_amount, _depositsCount);

        // Send ETH to staking router via receiveDepositableEther
        IStakingRouter(stakingRouter).receiveDepositableEther{value: _amount}();
    }

    // Utility to fund the mock with ETH
    function fund() external payable {}
}
