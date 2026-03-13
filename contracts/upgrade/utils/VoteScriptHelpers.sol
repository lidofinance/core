// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity ^0.8.25;

import {IAccessControl} from "@openzeppelin/contracts-v5.2/access/extensions/IAccessControlEnumerable.sol";
import {OmnibusBase} from "./OmnibusBase.sol";

library VoteScriptHelpers {
    // function itemFwd(address forwarder, OmnibusBase.VoteItem memory voteItem)
    //     internal
    //     pure
    //     returns (OmnibusBase.VoteItem memory)
    // {
    //     voteItem.call = OmnibusBase._forwardCall(forwarder, voteItem.call.to, voteItem.call.data);
    //     return voteItem;
    // }

    // function itemFwd(address forwarder, string memory description, address to, bytes memory data)
    //     internal
    //     pure
    //     returns (OmnibusBase.VoteItem memory)
    // {
    //     return item(description, OmnibusBase._forwardCall(forwarder, to, data));
    // }

    function item(string memory description, address to, bytes memory data)
        internal
        pure
        returns (OmnibusBase.VoteItem memory)
    {
        return item(description, OmnibusBase.ScriptCall({to: to, data: data}));
    }

    function item(string memory description, OmnibusBase.ScriptCall memory call)
        internal
        pure
        returns (OmnibusBase.VoteItem memory)
    {
        return OmnibusBase.VoteItem({description: description, call: call});
    }

    // function item(string memory description, address to, bytes memory data) internal pure returns (OmnibusBase.VoteItem memory) {
    //     return VoteItem({description: description, call: ScriptCall({to: to, data: data})});
    // }

    function grantRole(address target, bytes32 role, address account)
        internal
        pure
        returns (OmnibusBase.ScriptCall memory)
    {
        return OmnibusBase.ScriptCall({to: target, data: abi.encodeCall(IAccessControl.grantRole, (role, account))});
    }

    function revokeRole(address target, bytes32 role, address account)
        internal
        pure
        returns (OmnibusBase.ScriptCall memory)
    {
        return OmnibusBase.ScriptCall({to: target, data: abi.encodeCall(IAccessControl.revokeRole, (role, account))});
    }
}
