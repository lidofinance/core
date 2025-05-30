pragma solidity 0.8.9;

contract StakingRouter__MockForTWG {
    error CustomRevertError(uint256 id, string reason);

    event Mock__onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes publicKey,
        uint256 withdrawalRequestPaidFee,
        uint256 exitType
    );

    bool private shouldRevert;
    bool private shouldRevertWithCustomError;

    function setShouldRevert(bool _shouldRevert) external {
        shouldRevert = _shouldRevert;
    }

    function setShouldRevertWithCustomError(bool _shouldRevert) external {
        shouldRevertWithCustomError = _shouldRevert;
    }

    function onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes calldata _publicKey,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external {
        if (shouldRevert) {
            revert("some reason");
        }

        if (shouldRevertWithCustomError) {
            revert CustomRevertError(42, "custom fail");
        }

        emit Mock__onValidatorExitTriggered(
            _stakingModuleId,
            _nodeOperatorId,
            _publicKey,
            _withdrawalRequestPaidFee,
            _exitType
        );
    }
}
