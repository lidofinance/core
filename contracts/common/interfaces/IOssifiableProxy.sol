// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line lido/fixed-compiler-version
pragma solidity >=0.4.24;

interface IOssifiableProxy {
    function proxy__upgradeTo(address newImplementation) external;
    function proxy__changeAdmin(address newAdmin) external;
    function proxy__getAdmin() external view returns (address);
    function proxy__getImplementation() external view returns (address);
}
