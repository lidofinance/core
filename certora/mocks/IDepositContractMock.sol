import { IDepositContract } from "contracts/common/interfaces/IDepositContract.sol";

contract IDepositContractMock is IDepositContract {
    bytes32 public override get_deposit_root;

    function deposit(
        bytes calldata pubkey,
        bytes calldata withdrawal_credentials,
        bytes calldata signature,
        bytes32 deposit_data_root
    ) external payable override {}
}
