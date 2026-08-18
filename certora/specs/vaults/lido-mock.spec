/* A mock for `Lido` based on `ILidoMock` */

methods {

    // `ILidoMock`
    function ILidoMock.mintExternalShares(
        address _recipient, uint256 _amountOfShares
    ) external => CVLmintExternalShares(_amountOfShares);
    function ILidoMock.burnExternalShares(
        uint256 _amountOfShares
    ) external => CVLburnExternalShares(_amountOfShares);
    function ILidoMock.getSharesByPooledEth(
        uint256 _ethAmount
    ) external returns (uint256) => CVLgetSharesByPooledEth(_ethAmount);
    function ILidoMock.getPooledEthByShares(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthByShares(_sharesAmount);
    function ILidoMock.getPooledEthBySharesRoundUp(
        uint256 _sharesAmount
    ) external returns (uint256) => CVLgetPooledEthBySharesRoundUp(_sharesAmount);
    function ILidoMock.rebalanceExternalEtherToInternal(
    ) external with (env e) => CVLrebalanceExternalEtherToInternal(e.msg.value);
    function ILidoMock.getTotalShares() external returns (uint256) => _totalShares;

    // NOTE: This summary may not be sound - it returns NONDET for simplification
    function ILidoMock.transferSharesFrom(
        address, address, uint256
    ) external returns (uint256) => NONDET;
}
// -- Summary ghosts and functions ---------------------------------------------

ghost uint256 _totalShares {
    // NOTE: Requirement to prevent overflow - total shares bounded by uint128
    axiom _totalShares <= max_uint128;
}


ghost uint256 _externalShares {
    // NOTE: External shares must always be less than total shares
    axiom _externalShares < _totalShares;
}


ghost uint256 _internalEth {
    // NOTE: Internal ETH must be positive and bounded by uint128
    // The positivity requirement is an assumption to avoid division by zero
    axiom _internalEth > 0 && _internalEth <= max_uint128;
}


definition _internalShares() returns uint256 = (
    assert_uint256(_totalShares - _externalShares)
);


/// @dev Summarizes `Lido.getSharesByPooledEth`
/// @notice While the original function will revert if `_ethAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetSharesByPooledEth(uint256 _ethAmount) returns uint256 {
    require(
        _ethAmount <= max_uint128,
        "Lido.getSharesByPooledEth reverts if _ethAmount is bigger"
    );
    uint256 numeratorInEther = _internalEth;
    uint256 denominatorInShares = _internalShares();
    return require_uint256((_ethAmount * denominatorInShares) / numeratorInEther);
}


/// @dev Summarizes `Lido.getPooledEthBySharesRoundUp`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthBySharesRoundUp(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    uint256 numeratorInEther = _internalEth;
    uint256 denominatorInShares = _internalShares();

    return assert_uint256(
        // Add `denominatorInShares - 1` to round up
        (_sharesAmount * numeratorInEther + denominatorInShares - 1)
        / denominatorInShares
    );
}


/// @dev Summarizes `Lido.getPooledEthByShares`
/// @notice While the original function will revert if `_sharesAmount` exceeds `UINT128_MAX`,
/// this summary will not.
function CVLgetPooledEthByShares(uint256 _sharesAmount) returns uint256 {
    require(
        _sharesAmount <= max_uint128,
        "Lido.getPooledEthBySharesRoundUp reverts if _sharesAmount is bigger"
    );
    uint256 numeratorInEther = _internalEth;
    uint256 denominatorInShares = _internalShares();

    return assert_uint256(
        (_sharesAmount * numeratorInEther) / denominatorInShares
    );
}


/// @dev Summarizes `Lido.mintExternalShares`
/// @notice While the original function will revert if either `_recipient` or
/// `_amountOfShares` is zero, or `_amountOfShares` is too high, this summary will not.
function CVLmintExternalShares(uint256 _amountOfShares) {
    _externalShares = require_uint256(_externalShares + _amountOfShares);
    _totalShares = require_uint256(_totalShares + _amountOfShares);
}


/// @dev Summarizes `Lido.burnExternalShares`
/// @notice While the original function will revert if `_amountOfShares` is zero
/// or too large this summary will not.
function CVLburnExternalShares(uint256 _amountOfShares) {
    _externalShares = require_uint256(_externalShares - _amountOfShares);
    _totalShares = require_uint256(_totalShares - _amountOfShares);
}


/// @dev Summarizes `Lido.rebalanceExternalEtherToInternal`
/// @notice While the original function will revert if `msg_value` is zero or too large
/// this summary will not.
function CVLrebalanceExternalEtherToInternal(uint256 msg_value) {
    uint256 amountOfShares = CVLgetSharesByPooledEth(msg_value);
    _externalShares = require_uint256(_externalShares - amountOfShares);
    _internalEth = require_uint256(_internalEth + msg_value);
}
