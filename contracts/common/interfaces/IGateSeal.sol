// SPDX-FileCopyrightText: 2025 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

// https://github.com/lidofinance/gate-seals/blob/main/contracts/GateSeal.vy
interface IGateSeal {
    function seal(address[] memory _sealables) external;
    function is_expired() external view returns (bool);
    function get_sealing_committee() external view returns (address);
}
