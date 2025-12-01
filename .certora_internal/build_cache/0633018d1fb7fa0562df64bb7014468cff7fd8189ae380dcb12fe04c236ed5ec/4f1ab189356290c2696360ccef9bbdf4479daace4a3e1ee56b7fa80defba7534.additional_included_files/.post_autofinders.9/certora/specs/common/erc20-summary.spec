import "./ERC20Standard.spec";

methods {
    function _.transfer(address to, uint256 amount) external with (env e)
        => transferCVL(calledContract, e.block.timestamp, e.msg.sender, to, amount) expect bool;
    
    function _.transferFrom(address from, address to, uint256 amount) external with (env e) 
        => transferFromCVL(calledContract, e.block.timestamp, e.msg.sender, from, to, amount) expect bool;
    
    function _.balanceOf(address account) external with (env e) => 
        balanceOfCVL(calledContract, e.block.timestamp, account) expect uint256;
    
    function _.allowance(address account, address spender) external => 
        allowanceCVL(calledContract, account, spender) expect uint256;

    function _.decimals() external => 
        decimalsCVL(calledContract) expect uint256;

    function _.totalSupply() external with (env e) =>
        totalSupplyCVL(calledContract, e.block.timestamp) expect uint256;

    function _.approve(address spender, uint amount) external with (env e) =>
        approveCVL(calledContract, e.msg.sender, spender, amount) expect bool;
}
