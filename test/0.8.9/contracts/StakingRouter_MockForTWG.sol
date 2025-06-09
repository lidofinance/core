pragma solidity 0.8.9;

struct ValidatorData {
    uint256 stakingModuleId;
    uint256 nodeOperatorId;
    bytes pubkey;
}

contract StakingRouter__MockForTWG {
    error CustomRevertError(uint256 id, string reason);

    event Mock__onValidatorExitTriggered(
        uint256 _stakingModuleId,
        uint256 _nodeOperatorId,
        bytes publicKey,
        uint256 withdrawalRequestPaidFee,
        uint256 exitType
    );

    function onValidatorExitTriggered(
        ValidatorData[] calldata validatorData,
        uint256 _withdrawalRequestPaidFee,
        uint256 _exitType
    ) external {
        for (uint256 i = 0; i < validatorData.length; ++i) {
            emit Mock__onValidatorExitTriggered(
                validatorData[i].stakingModuleId,
                validatorData[i].nodeOperatorId,
                validatorData[i].pubkey,
                _withdrawalRequestPaidFee,
                _exitType
            );
        }
    }
}
