// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

// See contracts/COMPILERS.md
// solhint-disable-next-line
pragma solidity >=0.4.24 <0.9.0;

// https://github.com/lidofinance/gate-seals/blob/main/contracts/GateSealFactory.vy
interface IGateSealFactory {

    event GateSealCreated(address gate_seal);

    function create_gate_seal(
        address _sealing_committee,
        uint256 _seal_duration_seconds,
        address[] memory _sealables,
        uint256 _expiry_timestamp
    ) external;

}
