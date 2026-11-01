/* Spec for `NodeOperatorsRegistry` */

methods {
    function getNodeOperatorsCount() external returns (uint256) envfree;

    // `IKernel` called by `AragonApp`
    function _.hasPermission(address, address, bytes32, bytes) external => NONDET;

    // `ConversionHelpers` Lib (`node_modules/@aragon/os/contracts/common/ConversionHelpers.sol`
    // called by `AragonApp`
    // The summary below is not sound since we return a reference type, however it is
    // only used as parameter for `hasPermission` above, which is summarized as `NONDET`.
    function ConversionHelpers.dangerouslyCastUintArrayToBytes(
        uint256[] memory
    ) internal returns (bytes memory) => CVLNondetBytes();

    // `SigningKeys` library - summarized to avoid pointer analysis failures
    function SigningKeys.initKeysSigsBuf(uint256 _count) internal returns (
        bytes memory, bytes memory
    ) => CVLNondetTwoBytes(_count);

    function SigningKeys.loadKeysSigs(
        bytes32, uint256, uint256, uint256, bytes memory, bytes memory, uint256
    ) internal => NONDET;
}


/// @dev A non-deterministic bytes array
function CVLNondetBytes() returns bytes {
    bytes ret;
    return ret;
}


/// @dev This is `PUBKEY_LENGTH` defined is `contracts/0.4.24/lib/SigningKeys.sol`
definition PUBKEY_LENGTH() returns uint64 = 48;

/// @dev Two non-deterministic bytes arrays
function CVLNondetTwoBytes(uint256 _count) returns (bytes, bytes) {
    mathint len = _count * PUBKEY_LENGTH();
    bytes arr1;
    bytes arr2;
    require(arr1.length == len && arr2.length == len, "Correct length requirement");
    return (arr1, arr2);
}


definition isSupported(method f) returns bool = (
    f.selector != sig:transferToVault(address).selector && // Unsupported, reverts
    f.selector != sig:obtainDepositData(uint256,bytes).selector // Prover cannot resolve MinFirstAllocationStrategy library call
);


/// @title The number of node operators is weakly monotonic increasing
rule operatorsCountIsIncreasing(method f) filtered {f -> isSupported(f)} {
    uint256 numBefore = getNodeOperatorsCount();

    env e;
    calldataarg args;
    f(e, args);

    uint256 numAfter = getNodeOperatorsCount();
    assert(numAfter >= numBefore, "Number of operators does not decrease");
    assert(numAfter <= numBefore + 1, "Number of operators increases at most by 1");
}
