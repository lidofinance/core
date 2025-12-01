/* Common summaries for `Lido` contract */

using LidoHarness as __Lido; // Double underscore to avoid conflicts

methods {
    // `LidoHarness`
    function Lido._getLidoLocator() internal returns (address) => _LidoLocator;
    function LidoHarness.sharesOf(address) external returns (uint256) envfree;
    function LidoHarness.getTotalShares() external returns (uint256) envfree;
    function LidoHarness.getExternalShares() external returns (uint256) envfree;
    function LidoHarness.getInternalEther() external returns (uint256) envfree;
    function LidoHarness.getTotalPooledEther() external returns (uint256) envfree;
    function LidoHarness.getShareRateNumerator() external returns (uint256) envfree;
    function LidoHarness.getShareRateDenominator() external returns (uint256) envfree;
    function LidoHarness.getBufferedEther() external returns (uint256) envfree;
    function LidoHarness.getDepositedValidators() external returns (uint256) envfree;
    function LidoHarness.getPrevStakeLimit() external returns (uint96) envfree;
    function LidoHarness.getPrevStakeBlockNumber() external returns (uint32) envfree;
    function LidoHarness.getMaxStakeLimit() external returns (uint96) envfree;
    function LidoHarness.getMaxStakeLimitGrowthBlocks() external returns (uint32) envfree;
    function LidoHarness.getBalanceAndClValidators() external returns (uint256, uint256) envfree;
    function LidoHarness.allowance(address, address) external returns (uint256) envfree;

    // Deleted to prevent static analysis issues
    function LidoHarness.eip712Domain() external returns (
        string, string, uint256, address
    ) => CVLeip712Domain() DELETE;

    function LidoHarness.getSharesByPooledEth(
        uint256 _ethAmount
    ) external returns (uint256) => CVLgetSharesByPooledEth(_ethAmount);
    function LidoHarness.getPooledEthByShares(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthByShares(_sharesAmount);
    function LidoHarness.getPooledEthBySharesRoundUp(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesRoundUp(_sharesAmount);
}

// -- Summary functions --------------------------------------------------------

/// @dev Summarize the multiplication and division to reduce chances of timeout.
/// @notice While the original function will revert if `_ethAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetSharesByPooledEth(uint256 _ethAmount) returns uint256 {
    uint256 numeratorInEther = __Lido.getShareRateNumerator();
    uint256 denominatorInShares = __Lido.getShareRateDenominator();

    require(
        numeratorInEther > 0, "Avoid division by zero in getSharesByPooledEth summary"
    );
    // TODO: verify in a rule
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256((_ethAmount * denominatorInShares) / numeratorInEther);
}


/// @dev Summarizes `Lido.getPooledEthByShares`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthByShares(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    uint256 numeratorInEther = __Lido.getShareRateNumerator();
    uint256 denominatorInShares = __Lido.getShareRateDenominator();
    require(
        denominatorInShares > 0,
        "Avoid division by zero in getPooledEthBySharesRoundUp summary"
    );
    // TODO: notify Lido this might overflow
    require(
        numeratorInEther < 2^128,
        "Prevent numeratorInEther * _shareAmount from overflowing in getPooledEthBySharesRoundUp"
    );
    // TODO: verify in a rule
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256(
        (_sharesAmount * numeratorInEther) / denominatorInShares
    );
}


/// @dev Summarize the multiplication and division to reduce chances of timeout.
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesRoundUp(uint256 _sharesAmount) returns uint256 {
    uint256 numeratorInEther = __Lido.getShareRateNumerator();
    uint256 denominatorInShares = __Lido.getShareRateDenominator();

    require(
        denominatorInShares > 0,
        "Avoid division by zero in getPooledEthBySharesRoundUp summary"
    );
    // TODO: notify Lido this might overflow
    require(
        numeratorInEther < 2^128,
        "Prevent numeratorInEther * _shareAmount from overflowing in getPooledEthBySharesRoundUp"
    );
    // TODO: verify in a rule
    require(
        denominatorInShares < 2^128, 
        "Cannot be higher than 2^128 due to the way it is stored"
    );

    return require_uint256(
        // Add `denominatorInShares - 1` to round up
        (_sharesAmount * numeratorInEther + denominatorInShares - 1)
        / denominatorInShares
    );
}


/// @dev Summarize `Lido.eip712Domain` as non-deterministic
function CVLeip712Domain() returns (string, string, uint256, address) {
    string name;
    string version;
    uint256 chainId;
    address verifyingContract;
    return (name, version, chainId, verifyingContract);
}
