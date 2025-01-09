interface ILidoLocator {
    function lido() external view returns (address);

    function wstETH() external view returns (address);
}

contract LidoLocator__HarnessForDashboard is ILidoLocator {
    address private immutable LIDO;
    address private immutable WSTETH;

    constructor(
        address _lido,
        address _wstETH
    ) {
        LIDO = _lido;
        WSTETH = _wstETH;
    }

    function lido() external view returns (address) {
        return LIDO;
    }

    function wstETH() external view returns (address) {
        return WSTETH;
    }
}
