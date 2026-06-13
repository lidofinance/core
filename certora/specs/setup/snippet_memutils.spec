methods {
    function _.unsafeAllocateBytes(uint256 _len) internal => CVL_unsafeAllocateBytes(_len) expect (bytes memory);
    function _.memcpy(uint256 _src, uint256 _dst, uint256 _len) internal => NONDET;

    function _.dangerouslyCastUintArrayToBytes(uint256[] memory _input) internal
        => CVL_unsafeAllocateBytes(require_uint256(_input.length * 32)) expect (bytes memory);
}

function CVL_unsafeAllocateBytes(uint256 len) returns (bytes) {
    bytes ret;
    require(ret.length == len);
    return ret;
}
