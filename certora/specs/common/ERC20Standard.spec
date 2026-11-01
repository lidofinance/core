import "./ERC20Storage.spec";

/*
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Summarizations                                                                                 
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
*/

function totalSupplyCVL(address token, uint256 timestamp) returns uint256
{
    require token != NATIVE();
    return supplyByToken[token];
}

function transferCVL(address token, uint256 timestamp, address from, address to, uint256 amount) returns bool 
{
    require sumOfPairLessEqualThanSupply(token, from, to);
    return transferCVLStandard(token, from, to, amount);
}

function transferFromCVL(address token, uint256 timestamp, address spender, address from, address to, uint256 amount) returns bool 
{
    require sumOfPairLessEqualThanSupply(token, from, to);
    return transferFromCVLStandard(token, spender, from, to, amount);
}

function balanceOfCVL(address token, uint256 timestamp, address account) returns uint256 {
    /// The balance of any user cannot surpass than the total supply.
    require balanceByToken[token][account] <= supplyByToken[token];
    require token != NATIVE();
    return balanceByToken[token][account];
}

function approveCVL(address token, address account, address spender, uint256 amount) returns bool {
    allowanceByToken[token][account][spender] = amount;
    return true;
}

function allowanceCVL(address token, address account, address spender) returns uint256 {
    require token != NATIVE();
    return allowanceByToken[token][account][spender];
}

/*
┌─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Function implementations                                                                                 
└─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
*/

function transferFromCVLStandard(address token, address spender, address from, address to, uint256 amount) returns bool {
    require spender != from => allowanceByToken[token][from][spender] >= amount;
    //if (allowanceByToken[token][from][spender] < amount) return false;
    bool success = transferCVLStandard(token, from, to, amount);
    if(success && spender != from) {
        allowanceByToken[token][from][spender] = assert_uint256(allowanceByToken[token][from][spender] - amount);
    }
    return success;
}

function transferCVLStandard(address token, address from, address to, uint256 amount) returns bool {
    require balanceByToken[token][from] >= amount;
    //if(balanceByToken[token][from] < amount) return false;
    balanceByToken[token][from] = assert_uint256(balanceByToken[token][from] - amount);
    balanceByToken[token][to] = require_uint256(balanceByToken[token][to] + amount);  // We neglect overflows.
    return true;
}
