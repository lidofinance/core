import { Burner } from "contracts/0.8.9/Burner.sol";

contract OldBurnerMock is Burner {
    constructor(address _locator, address _stETH)
        Burner(_locator, _stETH)
    {}
}
