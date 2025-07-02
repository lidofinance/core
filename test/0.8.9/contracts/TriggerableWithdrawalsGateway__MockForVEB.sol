pragma solidity 0.8.9;

contract TriggerableWithdrawalsGateway__MockForVEB {
    event Mock__triggerFullWithdrawalsTriggered(uint256 exitsCount, address refundRecipient, uint256 exitType);

    struct ValidatorData {
        uint256 stakingModuleId;
        uint256 nodeOperatorId;
        bytes pubkey;
    }

    function triggerFullWithdrawals(
        ValidatorData[] calldata triggerableExitData,
        address refundRecipient,
        uint256 exitType
    ) external payable {
        emit Mock__triggerFullWithdrawalsTriggered(triggerableExitData.length, refundRecipient, exitType);
    }
}
