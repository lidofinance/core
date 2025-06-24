// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity >=0.8.0;

// inspired by Waffle's Doppelganger
// TODO: add Custom error support
// TODO: add TS wrapper
// How it works
// Queues imitated calls (return values, reverts) based on msg.data
// Fallback retrieves the imitated calls based on msg.data
contract Mimic {
    struct ImitatedCall {
        bytes32 next;
        bool reverts;
        string revertReason;
        bytes returnValue;
    }
    mapping(bytes32 => ImitatedCall) imitations;
    mapping(bytes32 => bytes32) tails;
    bool receiveReverts;
    string receiveRevertReason;

    fallback() external payable {
        ImitatedCall memory imitatedCall = __internal__getImitatedCall();
        if (imitatedCall.reverts) {
            __internal__imitateRevert(imitatedCall.revertReason);
        }
        __internal__imitateReturn(imitatedCall.returnValue);
    }

    receive() external payable {
        require(receiveReverts == false, receiveRevertReason);
    }

    function __clearQueue(bytes32 at) private {
        tails[at] = at;
        while (imitations[at].next != "") {
            bytes32 next = imitations[at].next;
            delete imitations[at];
            at = next;
        }
    }

    function __mimic__queueRevert(bytes memory data, string memory reason) public {
        bytes32 root = keccak256(data);
        bytes32 tail = tails[root];
        if (tail == "") tail = keccak256(data);
        tails[root] = keccak256(abi.encodePacked(tail));
        imitations[tail] = ImitatedCall({next: tails[root], reverts: true, revertReason: reason, returnValue: ""});
    }

    function __mimic__imitateReverts(bytes memory data, string memory reason) public {
        __clearQueue(keccak256(data));
        __mimic__queueRevert(data, reason);
    }

    function __mimic__queueReturn(bytes memory data, bytes memory value) public {
        bytes32 root = keccak256(data);
        bytes32 tail = tails[root];
        if (tail == "") tail = keccak256(data);
        tails[root] = keccak256(abi.encodePacked(tail));
        imitations[tail] = ImitatedCall({next: tails[root], reverts: false, revertReason: "", returnValue: value});
    }

    function __mimic__imitateReturns(bytes memory data, bytes memory value) public {
        __clearQueue(keccak256(data));
        __mimic__queueReturn(data, value);
    }

    function __mimic__receiveReverts(string memory reason) public {
        receiveReverts = true;
        receiveRevertReason = reason;
    }

    function __mimic__call(address target, bytes calldata data) external returns (bytes memory) {
        (bool succeeded, bytes memory returnValue) = target.call(data);
        require(succeeded, string(returnValue));
        return returnValue;
    }

    function __mimic__staticcall(address target, bytes calldata data) external view returns (bytes memory) {
        (bool succeeded, bytes memory returnValue) = target.staticcall(data);
        require(succeeded, string(returnValue));
        return returnValue;
    }

    function __internal__getImitatedCall() private returns (ImitatedCall memory imitatedCall) {
        bytes32 root = keccak256(msg.data);
        imitatedCall = imitations[root];
        if (imitatedCall.next != "") {
            if (imitations[imitatedCall.next].next != "") {
                imitations[root] = imitations[imitatedCall.next];
                delete imitations[imitatedCall.next];
            }
            return imitatedCall;
        }
        root = keccak256(abi.encodePacked(msg.sig));
        imitatedCall = imitations[root];
        if (imitatedCall.next != "") {
            if (imitations[imitatedCall.next].next != "") {
                imitations[root] = imitations[imitatedCall.next];
                delete imitations[imitatedCall.next];
            }
            return imitatedCall;
        }
        revert("Imitation on the method is not initialized");
    }

    function __internal__imitateReturn(bytes memory ret) private pure {
        assembly {
            return(add(ret, 0x20), mload(ret))
        }
    }

    function __internal__imitateRevert(string memory reason) private pure {
        revert(reason);
    }
}
