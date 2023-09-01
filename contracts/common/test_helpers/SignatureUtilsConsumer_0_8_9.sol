// SPDX-FileCopyrightText: 2023 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

pragma solidity 0.8.9;

import {SignatureUtils} from "../lib/SignatureUtils.sol";


contract SignatureUtilsConsumer_0_8_9 {

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
