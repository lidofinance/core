// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0
// for testing purposes only

pragma solidity 0.8.9;

contract LidoMockForDepositSecurityModule {
    bool internal canDepositState;

    event StakingModuleDeposited(uint24 stakingModuleId, bytes depositCalldata);
    event Deposited(uint256 maxDeposits);

    constructor() {
        canDepositState = true;
    }

    function setCanDeposit(bool _canDeposit) external {
        canDepositState = _canDeposit;
    }

    function deposit(
        uint256 stakingModuleId,
        bytes calldata depositCalldata
    ) external {
        emit StakingModuleDeposited(uint24(stakingModuleId), depositCalldata);
    }

    function canDeposit() external view returns(bool) {
        return canDepositState;
    }
}
