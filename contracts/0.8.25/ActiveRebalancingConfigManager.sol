// SPDX-FileCopyrightText: 2026 Lido <info@lido.fi>
// SPDX-License-Identifier: GPL-3.0

/* See contracts/COMPILERS.md */
pragma solidity 0.8.25;

import {AccessControlEnumerable} from "@openzeppelin/contracts-v5.2/access/extensions/AccessControlEnumerable.sol";

interface IOracleDaemonConfig {
    function update(string calldata _key, bytes calldata _value) external;
}

/**
 * @title ActiveRebalancingConfigManager
 * @author Lido
 * @notice Lets the manager role update the five `ACTIVE_REBALANCING_*` keys of the OracleDaemonConfig (LIP-38),
 *         each numeric value within bounds fixed at deployment.
 * @dev The OracleDaemonConfig gates every key behind one `CONFIG_MANAGER_ROLE`. This contract holds that role,
 *      so its key list and its bounds are the only limits on the manager. It never adds or removes a key: the
 *      OracleDaemonConfig rejects an update of an absent key. Changing the bounds needs a new deployment and a
 *      DAO vote that moves the role to it.
 */
contract ActiveRebalancingConfigManager is AccessControlEnumerable {
    struct Bounds {
        uint256 min;
        uint256 max;
    }

    struct KeyBounds {
        Bounds rateLimit; // ETH
        Bounds operatorExcessBP;
        Bounds moduleExcessBP;
        Bounds gracePeriodEpochs;
    }

    bytes32 public constant ACTIVE_REBALANCING_MANAGER_ROLE = keccak256("ACTIVE_REBALANCING_MANAGER_ROLE");

    string internal constant ACTIVE_REBALANCING_ENABLED = "ACTIVE_REBALANCING_ENABLED";
    string internal constant ACTIVE_REBALANCING_RATE_LIMIT = "ACTIVE_REBALANCING_RATE_LIMIT";
    string internal constant ACTIVE_REBALANCING_OPERATOR_EXCESS_BP = "ACTIVE_REBALANCING_OPERATOR_EXCESS_BP";
    string internal constant ACTIVE_REBALANCING_MODULE_EXCESS_BP = "ACTIVE_REBALANCING_MODULE_EXCESS_BP";
    string internal constant ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS = "ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS";

    IOracleDaemonConfig public immutable ORACLE_DAEMON_CONFIG;

    uint256 internal immutable RATE_LIMIT_MIN;
    uint256 internal immutable RATE_LIMIT_MAX;
    uint256 internal immutable OPERATOR_EXCESS_BP_MIN;
    uint256 internal immutable OPERATOR_EXCESS_BP_MAX;
    uint256 internal immutable MODULE_EXCESS_BP_MIN;
    uint256 internal immutable MODULE_EXCESS_BP_MAX;
    uint256 internal immutable GRACE_PERIOD_EPOCHS_MIN;
    uint256 internal immutable GRACE_PERIOD_EPOCHS_MAX;

    error ZeroArgument(string name);
    error InvalidBounds(string key, uint256 min, uint256 max);
    error ValueOutOfBounds(string key, uint256 value, uint256 min, uint256 max);

    /**
     * @param admin The `DEFAULT_ADMIN_ROLE` holder, which grants the manager role
     * @param oracleDaemonConfig The OracleDaemonConfig whose keys this contract updates
     * @param bounds Inclusive bounds of the numeric keys
     */
    constructor(address admin, address oracleDaemonConfig, KeyBounds memory bounds) {
        if (admin == address(0)) revert ZeroArgument("admin");
        if (oracleDaemonConfig == address(0)) revert ZeroArgument("oracleDaemonConfig");
        _checkBounds(ACTIVE_REBALANCING_RATE_LIMIT, bounds.rateLimit);
        _checkBounds(ACTIVE_REBALANCING_OPERATOR_EXCESS_BP, bounds.operatorExcessBP);
        _checkBounds(ACTIVE_REBALANCING_MODULE_EXCESS_BP, bounds.moduleExcessBP);
        _checkBounds(ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS, bounds.gracePeriodEpochs);

        ORACLE_DAEMON_CONFIG = IOracleDaemonConfig(oracleDaemonConfig);
        RATE_LIMIT_MIN = bounds.rateLimit.min;
        RATE_LIMIT_MAX = bounds.rateLimit.max;
        OPERATOR_EXCESS_BP_MIN = bounds.operatorExcessBP.min;
        OPERATOR_EXCESS_BP_MAX = bounds.operatorExcessBP.max;
        MODULE_EXCESS_BP_MIN = bounds.moduleExcessBP.min;
        MODULE_EXCESS_BP_MAX = bounds.moduleExcessBP.max;
        GRACE_PERIOD_EPOCHS_MIN = bounds.gracePeriodEpochs.min;
        GRACE_PERIOD_EPOCHS_MAX = bounds.gracePeriodEpochs.max;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Switches Phase 3 of the oracle exit iterator on or off; no bound applies
    function setEnabled(bool enabled) external onlyRole(ACTIVE_REBALANCING_MANAGER_ROLE) {
        _update(ACTIVE_REBALANCING_ENABLED, enabled ? 1 : 0);
    }

    /// @notice Sets the max stake rebalancing may exit in one WithdrawalsOracle report, in ETH
    function setRateLimit(uint256 rateLimit) external onlyRole(ACTIVE_REBALANCING_MANAGER_ROLE) {
        _checkValue(ACTIVE_REBALANCING_RATE_LIMIT, rateLimit, RATE_LIMIT_MIN, RATE_LIMIT_MAX);
        _update(ACTIVE_REBALANCING_RATE_LIMIT, rateLimit);
    }

    /// @notice Sets the operator-level trigger, in basis points of the operator target stake
    function setOperatorExcessBP(uint256 excessBP) external onlyRole(ACTIVE_REBALANCING_MANAGER_ROLE) {
        _checkValue(ACTIVE_REBALANCING_OPERATOR_EXCESS_BP, excessBP, OPERATOR_EXCESS_BP_MIN, OPERATOR_EXCESS_BP_MAX);
        _update(ACTIVE_REBALANCING_OPERATOR_EXCESS_BP, excessBP);
    }

    /// @notice Sets the module-level trigger, in basis points of the module stake
    function setModuleExcessBP(uint256 excessBP) external onlyRole(ACTIVE_REBALANCING_MANAGER_ROLE) {
        _checkValue(ACTIVE_REBALANCING_MODULE_EXCESS_BP, excessBP, MODULE_EXCESS_BP_MIN, MODULE_EXCESS_BP_MAX);
        _update(ACTIVE_REBALANCING_MODULE_EXCESS_BP, excessBP);
    }

    /// @notice Sets the new operator grace period, in epochs since its first validator activation
    function setGracePeriodEpochs(uint256 epochs) external onlyRole(ACTIVE_REBALANCING_MANAGER_ROLE) {
        _checkValue(ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS, epochs, GRACE_PERIOD_EPOCHS_MIN, GRACE_PERIOD_EPOCHS_MAX);
        _update(ACTIVE_REBALANCING_GRACE_PERIOD_EPOCHS, epochs);
    }

    function getBounds() external view returns (KeyBounds memory) {
        return
            KeyBounds({
                rateLimit: Bounds(RATE_LIMIT_MIN, RATE_LIMIT_MAX),
                operatorExcessBP: Bounds(OPERATOR_EXCESS_BP_MIN, OPERATOR_EXCESS_BP_MAX),
                moduleExcessBP: Bounds(MODULE_EXCESS_BP_MIN, MODULE_EXCESS_BP_MAX),
                gracePeriodEpochs: Bounds(GRACE_PERIOD_EPOCHS_MIN, GRACE_PERIOD_EPOCHS_MAX)
            });
    }

    function _update(string memory key, uint256 value) internal {
        ORACLE_DAEMON_CONFIG.update(key, _encode(value));
    }

    /// @dev The encoding of the existing keys: shortest big-endian, at least one byte (0 is `0x00`, 256 is `0x0100`).
    function _encode(uint256 value) internal pure returns (bytes memory encoded) {
        uint256 length = 1;
        for (uint256 rest = value >> 8; rest != 0; rest >>= 8) {
            ++length;
        }
        encoded = new bytes(length);
        for (uint256 i = length; i != 0; --i) {
            encoded[i - 1] = bytes1(uint8(value));
            value >>= 8;
        }
    }

    function _checkBounds(string memory key, Bounds memory bounds) internal pure {
        if (bounds.min > bounds.max) revert InvalidBounds(key, bounds.min, bounds.max);
    }

    function _checkValue(string memory key, uint256 value, uint256 min, uint256 max) internal pure {
        if (value < min || value > max) revert ValueOutOfBounds(key, value, min, max);
    }
}
