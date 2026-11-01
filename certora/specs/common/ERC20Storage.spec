import "./ERC20Params.spec";

/// Bare storage of ERC20 tokens
ghost mapping(address /* token */ => uint256) supplyByToken {
    axiom forall address token. supplyByToken[token] <= MAX_SUPPLY();
}
ghost mapping(address /* token */ => mapping(address /* account */ => uint256)) balanceByToken;
ghost mapping(address /* token */ => mapping(address /* account */ => mapping(address /* spender */ => uint256))) allowanceByToken;

/// Returns the decimals of a token [STATIC]
persistent ghost decimalsCVL(address /* token */) returns uint256;

/// Returns whether a token is rebasing or not. [STATIC]
persistent ghost isRebasing(address /* token */) returns bool;

function sumOfPairLessEqualThanSupply(address token, address user1, address user2) returns bool {
    return balanceByToken[token][user1] <= supplyByToken[token] &&
        (user1 != user2 => 
            balanceByToken[token][user1] + balanceByToken[token][user2] <= supplyByToken[token]);
}
