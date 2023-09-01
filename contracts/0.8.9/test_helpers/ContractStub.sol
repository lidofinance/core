// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

///
/// DATA TYPES
///

/// @notice Stores method stubs of the ContractStub's frame
struct ContractStubFrame {
    /// @notice list of method stubs declared in the given frame (order is not guaranteed)
    MethodStub[] methodStubs;
    /// @notice method stub indices increased to 1 by the id of methods stub
    mapping(bytes32 => uint256) indicesByIdOneBased;
}

/// @notice Method stub config
struct MethodStub {
    /// @notice value of the msg.data on which method stub will be triggered on
    bytes input;
    /// @notice abi encoded data to be returned or reverted from the method stub
    bytes output;
    /// @notice whether method ends with Yul's revert() or return() instruction
    bool isRevert;
    /// @notice potentially state modifying side effects. Side effects take place
    ///     ONLY when isRevert is set to false.
    SideEffects sideEffects;
}

/// @notice Side effects of the method stub
struct SideEffects {
    /// @notice whether the ContractStub__call event should be emitted on method stub execution
    bool traceable;
    /// @notice number of the frame to set as active after the method stub executed
    uint256 nextFrame;
    /// @notice logs to generate during method stub execution
    Log[] logs;
    /// @notice list of calls to external contracts
    ExternalCall[] externalCalls;
    /// @notice ETH transfers to make via ETHForwarder contract instances. Use when a recipient
    ///     doesn't accept ETH by default
    ForwardETH[] ethForwards;
}

/// @notice Stores Yul's log instruction data
struct Log {
    LogType logType;
    bytes data;
    bytes32 t1;
    bytes32 t2;
    bytes32 t3;
    bytes32 t4;
}

/// @notice Type of Yul's log instruction
enum LogType {
    LOG0,
    LOG1,
    LOG2,
    LOG3,
    LOG4
}

struct ForwardETH {
    address payable recipient;
    uint256 value;
}

struct ExternalCall {
    address payable callee;
    bytes data;
    uint256 value;
    uint256 gas;
}

///
/// MAIN CONTRACTS
///

/// @notice Allows to stub the functionality of the Solidity contract
/// @dev WARNING: !!! DO NOT USE IT IN PRODUCTION !!!
contract ContractStub {
    ContractStubStorage private immutable STORAGE;
    bytes4 private immutable GET_STORAGE_ADDRESS_METHOD_ID;

    constructor(bytes4 _getStorageAddressMethodId) {
        STORAGE = new ContractStubStorage();
        GET_STORAGE_ADDRESS_METHOD_ID = _getStorageAddressMethodId;
    }

    // solhint-disable-next-line
    fallback() external payable {
        if (bytes4(msg.data) == GET_STORAGE_ADDRESS_METHOD_ID) {
            _return(abi.encodePacked(address(STORAGE)));
        }
        MethodStub memory stub = _getMethodStub();
        if (stub.isRevert) {
            _revert(stub.output);
        }
        _logEvents(stub.sideEffects.logs);
        _forwardETH(stub.sideEffects.ethForwards);
        _makeExternalCalls(stub.sideEffects.externalCalls);
        _switchFrame(stub.sideEffects.nextFrame);
        _leaveTrace(stub.sideEffects.traceable);
        _return(stub.output);
    }

    function _getMethodStub() internal view returns (MethodStub memory) {
        return
            STORAGE.hasMethodStub(msg.data)
                ? STORAGE.getMethodStub(msg.data)
                : STORAGE.getMethodStub(msg.data[:4]);
    }

    function _revert(bytes memory _data) internal pure {
        assembly {
            revert(add(_data, 32), mload(_data))
        }
    }

    function _return(bytes memory _data) internal pure {
        assembly {
            return(add(_data, 32), mload(_data))
        }
    }

    function _switchFrame(uint256 _nextFrame) internal {
        if (_nextFrame != type(uint256).max) {
            STORAGE.activateFrame(_nextFrame);
        }
    }

    function _leaveTrace(bool _isTraceable) internal {
        if (!_isTraceable) return;
        emit ContractStub__called(
            msg.sender,
            bytes4(msg.data[:4]),
            msg.data[4:],
            msg.value,
            block.number
        );
    }

    function _logEvents(Log[] memory _logs) internal {
        for (uint256 i = 0; i < _logs.length; ++i) {
            bytes32 t1 = _logs[i].t1;
            bytes32 t2 = _logs[i].t2;
            bytes32 t3 = _logs[i].t3;
            bytes32 t4 = _logs[i].t4;
            bytes memory data = _logs[i].data;
            uint256 dataLength = data.length;
            if (_logs[i].logType == LogType.LOG0) {
                assembly {
                    log0(add(data, 32), dataLength)
                }
            } else if (_logs[i].logType == LogType.LOG1) {
                assembly {
                    log1(add(data, 32), dataLength, t1)
                }
            } else if (_logs[i].logType == LogType.LOG2) {
                assembly {
                    log2(add(data, 32), dataLength, t1, t2)
                }
            } else if (_logs[i].logType == LogType.LOG3) {
                assembly {
                    log3(add(data, 32), dataLength, t1, t2, t3)
                }
            } else if (_logs[i].logType == LogType.LOG4) {
                assembly {
                    log4(add(data, 32), dataLength, t1, t2, t3, t4)
                }
            }
        }
    }

    function _forwardETH(ForwardETH[] memory _ethForwards) internal {
        for (uint256 i = 0; i < _ethForwards.length; ++i) {
            ForwardETH memory ethForward = _ethForwards[i];
            new ETHForwarder{ value: ethForward.value }(ethForward.recipient);
            emit ContractStub__ethSent(ethForward.recipient, ethForward.value);
        }
    }

    function _makeExternalCalls(ExternalCall[] memory _calls) internal {
        for (uint256 i = 0; i < _calls.length; ++i) {
            ExternalCall memory externalCall = _calls[i];
            (bool success, bytes memory data) = externalCall.callee.call{
                value: externalCall.value,
                gas: externalCall.gas == 0 ? gasleft() : externalCall.gas
            }(externalCall.data);
            emit ContractStub__callResult(externalCall, success, data);
        }
    }

    // solhint-disable-next-line
    event ContractStub__ethSent(address recipient, uint256 value);

    // solhint-disable-next-line
    event ContractStub__called(
        address caller,
        bytes4 methodId,
        bytes callData,
        uint256 value,
        uint256 blockNumber
    );

    // solhint-disable-next-line
    event ContractStub__callResult(
        ExternalCall call,
        bool success,
        bytes response
    );
}

/// @notice Keeps the state of the ContractStub instance
contract ContractStubStorage {
    uint256 private constant EMPTY_FRAME_ID = type(uint256).max;

    mapping(uint256 => ContractStubFrame) private frames;
    uint256 public currentFrameNumber;

    function hasMethodStub(bytes memory callData) external view returns (bool) {
        bytes32 methodStubId = keccak256(callData);
        return
            frames[currentFrameNumber].indicesByIdOneBased[methodStubId] != 0;
    }

    function getMethodStub(
        bytes memory callData
    ) external view returns (MethodStub memory) {
        bytes32 methodStubId = keccak256(callData);
        uint256 methodStubIndex = frames[currentFrameNumber]
            .indicesByIdOneBased[methodStubId];
        if (methodStubIndex == 0)
            revert ContractStub__MethodStubNotFound(callData);
        return frames[currentFrameNumber].methodStubs[methodStubIndex - 1];
    }

    function addMethodStub(
        uint256 _frameNumber,
        MethodStub memory _methodStub
    ) external {
        uint256 frameNumber = _frameNumber == EMPTY_FRAME_ID
            ? currentFrameNumber
            : _frameNumber;
        frames[frameNumber].methodStubs.push();
        bytes32 stubId = keccak256(_methodStub.input);
        uint256 newStubIndex = frames[frameNumber].methodStubs.length - 1;
        frames[frameNumber].indicesByIdOneBased[stubId] = newStubIndex + 1;

        MethodStub storage methodStub = frames[frameNumber].methodStubs[
            newStubIndex
        ];

        methodStub.input = _methodStub.input;
        methodStub.output = _methodStub.output;
        methodStub.isRevert = _methodStub.isRevert;

        SideEffects storage sideEffects = methodStub.sideEffects;
        sideEffects.traceable = _methodStub.sideEffects.traceable;
        sideEffects.nextFrame = _methodStub.sideEffects.nextFrame;
        for (uint256 i = 0; i < _methodStub.sideEffects.logs.length; ++i) {
            sideEffects.logs.push(_methodStub.sideEffects.logs[i]);
        }
        for (
            uint256 i = 0;
            i < _methodStub.sideEffects.externalCalls.length;
            ++i
        ) {
            sideEffects.externalCalls.push(
                _methodStub.sideEffects.externalCalls[i]
            );
        }
        for (
            uint256 i = 0;
            i < _methodStub.sideEffects.ethForwards.length;
            ++i
        ) {
            sideEffects.ethForwards.push(
                _methodStub.sideEffects.ethForwards[i]
            );
        }
    }

    function activateFrame(uint256 _frameNumber) external {
        currentFrameNumber = _frameNumber;
    }

    error ContractStub__MethodStubNotFound(bytes callData);
}

///
/// HELPER CONTRACTS
///

/// @notice Helper contract to transfer ether via selfdestruct
contract ETHForwarder {
    constructor(address payable _recipient) payable {
        selfdestruct(_recipient);
    }
}
