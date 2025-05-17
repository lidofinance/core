pragma solidity 0.8.9;

contract TriggerableWithdrawalsGateway__MockForVEB {
    event Mock__triggerFullWithdrawalsTriggered(bytes triggerableExitData, address refundRecipient, uint8 exitType);

    function triggerFullWithdrawals(
        bytes calldata triggerableExitData,
        address refundRecipient,
        uint8 exitType
    ) external payable {
        emit Mock__triggerFullWithdrawalsTriggered(triggerableExitData, refundRecipient, exitType);
    }
}
