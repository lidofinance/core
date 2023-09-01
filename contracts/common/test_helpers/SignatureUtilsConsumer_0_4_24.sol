// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.4.24;

import {SignatureUtils} from "../lib/SignatureUtils.sol";


contract SignatureUtilsConsumer_0_4_24 {

    function isValidSignature(
        address signer,
        bytes32 msgHash,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external view returns (bool) {
        return SignatureUtils.isValidSignature(signer, msgHash, v, r, s);
    }

}
