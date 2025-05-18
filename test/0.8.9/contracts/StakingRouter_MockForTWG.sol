pragma solidity 0.8.9;

contract StakingRouter__MockForTWG {
    event Mock__onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes publicKey,
        uint256 withdrawalRequestPaidFee,
        uint256 exitType
    );

    function onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes calldata _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external {
        emit Mock__onValidatorExitTriggered(
            _stakingModuleId,
            _nodeOperatorId,
            _publicKey,
            _withdrawalRequestPaidFee,
            _exitType
        );
    }
}
