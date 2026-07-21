// SPDX-License-Identifier: UNLICENSED
// for testing purposes only

pragma solidity 0.8.9;

import {IERC1271} from "@openzeppelin/contracts-v4.4/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts-v4.4/utils/cryptography/ECDSA.sol";
import {IERC165} from "@openzeppelin/contracts-v4.4/utils/introspection/IERC165.sol";

contract ERC1271Guardian__Mock is IERC165, IERC1271 {
    enum ResponseMode {
        Normal,
        Invalid,
        Revert,
        Malformed
    }

    bytes4 internal constant EIP1271_MAGIC_VALUE = 0x1626ba7e;
    bytes4 internal constant EIP1271_INVALID = 0xffffffff;

    address public delegate;
    ResponseMode public interfaceResponseMode;
    ResponseMode public signatureResponseMode;

    error NotDelegate();
    error MockRevert();

    constructor(address delegate_) {
        delegate = delegate_;
    }

    function setDelegate(address delegate_) external {
        delegate = delegate_;
    }

    function setInterfaceResponseMode(ResponseMode mode) external {
        interfaceResponseMode = mode;
    }

    function setSignatureResponseMode(ResponseMode mode) external {
        signatureResponseMode = mode;
    }

    function supportsInterface(bytes4 interfaceId) external view override returns (bool) {
        if (interfaceResponseMode == ResponseMode.Revert) revert MockRevert();
        if (interfaceResponseMode == ResponseMode.Malformed) {
            assembly {
                mstore(0, 1)
                return(31, 1)
            }
        }
        if (interfaceResponseMode == ResponseMode.Invalid) return false;
        return interfaceId == type(IERC165).interfaceId || interfaceId == type(IERC1271).interfaceId;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view override returns (bytes4) {
        if (signatureResponseMode == ResponseMode.Revert) revert MockRevert();
        if (signatureResponseMode == ResponseMode.Malformed) {
            assembly {
                mstore(0, shl(224, EIP1271_MAGIC_VALUE))
                return(0, 1)
            }
        }
        if (signatureResponseMode == ResponseMode.Invalid || delegate == address(0)) return EIP1271_INVALID;
        return ECDSA.recover(hash, signature) == delegate ? EIP1271_MAGIC_VALUE : EIP1271_INVALID;
    }

    function execute(address target, bytes calldata data) external returns (bytes memory result) {
        if (msg.sender != delegate) revert NotDelegate();

        bool success;
        (success, result) = target.call(data);
        if (!success) {
            assembly {
                revert(add(result, 32), mload(result))
            }
        }
    }
}
