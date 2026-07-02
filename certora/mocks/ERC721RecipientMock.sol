import {IERC721TokenReceiver} from "foundry/lib/forge-std/src/interfaces/IERC721.sol";

contract ERC721RecipientMock is IERC721TokenReceiver {
    address public operator;
    address public from;
    uint256 public id;
    bytes public data;

    function onERC721Received(address _operator, address _from, uint256 _id, bytes calldata _data)
        public
        virtual
        override
        returns (bytes4)
    {
        operator = _operator;
        from = _from;
        id = _id;
        data = _data;

        return IERC721TokenReceiver.onERC721Received.selector;
    }
}
