"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const dotenv = __importStar(require("dotenv"));
const hardhat_1 = require("hardhat");
const path_1 = require("path");
const readline_1 = __importDefault(require("readline"));
const typechain_types_1 = require("typechain-types");
const lib_1 = require("lib");
dotenv.config({ path: (0, path_1.join)(__dirname, "../../.env") });
function getEnvVariable(name, defaultValue) {
    const value = process.env[name];
    if (value === undefined) {
        if (defaultValue === undefined) {
            throw new Error(`Env variable ${name} must be set`);
        }
        return defaultValue;
    }
    else {
        (0, lib_1.log)(`Using env variable ${name}=${value}`);
        return value;
    }
}
/* Accounting Oracle args */
// Must comply with the specification
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#time-parameters-1
const SECONDS_PER_SLOT = 12;
// Must match the beacon chain genesis_time: https://beaconstate-mainnet.chainsafe.io/eth/v1/beacon/genesis
// and the current value: https://etherscan.io/address/0x852deD011285fe67063a08005c71a85690503Cee#readProxyContract#F6
const GENESIS_TIME = 1606824023;
/* Oracle report sanity checker */
// Defines the maximum number of validators that may be reported as "exited"
// per day, depending on the consensus layer churn limit.
//
// CURRENT_ACTIVE_VALIDATORS_NUMBER = ~1100000 // https://beaconcha.in/
// CURRENT_EXIT_CHURN_LIMIT = 16 // https://www.validatorqueue.com/
// EPOCHS_PER_DAY = 225 // (24 * 60 * 60) sec / 12 sec per slot / 32 slots per epoch
//
// https://github.com/ethereum/consensus-specs/blob/dev/specs/deneb/beacon-chain.md#validator-cycle
// MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT = 8
//
// MAX_VALIDATORS_PER_DAY = EPOCHS_PER_DAY * MAX_PER_EPOCH_ACTIVATION_CHURN_LIMIT = 1800 // 225 * 8
// MAX_VALIDATORS_AFTER_TWO_YEARS = MAX_VALIDATORS_PER_DAY * 365 * 2 + CURRENT_VALIDATORS_NUMBER // 1100000 + (1800 * 365 * 2) = ~2500000
//
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#validator-cycle
// CHURN_LIMIT_QUOTIENT = 65536
//
// https://github.com/ethereum/consensus-specs/blob/dev/specs/phase0/beacon-chain.md#get_validator_churn_limit
// MAX_EXIT_CHURN_LIMIT_AFTER_TWO_YEARS = MAX_VALIDATORS_AFTER_TWO_YEARS / CHURN_LIMIT_QUOTIENT // 2500000 / 65536 = ~38
// EXITED_VALIDATORS_PER_DAY_LIMIT = MAX_EXIT_CHURN_LIMIT_AFTER_TWO_YEARS * EPOCHS_PER_DAY // 38 * 225 = 8550 = ~9000
const EXITED_VALIDATORS_PER_DAY_LIMIT = 9000;
// Defines the maximum number of validators that can be reported as "appeared"
// in a single day, limited by the maximum daily deposits via DSM
//
// BLOCKS_PER_DAY = (24 * 60 * 60) / 12 = 7200
// MAX_DEPOSITS_PER_BLOCK = 150
// MIN_DEPOSIT_BLOCK_DISTANCE = 25
//
// APPEARED_VALIDATORS_PER_DAY_LIMIT = BLOCKS_PER_DAY / MIN_DEPOSIT_BLOCK_DISTANCE * MAX_DEPOSITS_PER_BLOCK = 43200
// Current limits: https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F10
//                 https://etherscan.io/address/0xC77F8768774E1c9244BEed705C4354f2113CFc09#readContract#F11
// The proposed limits remain unchanged for curated modules and reduced for CSM
const APPEARED_VALIDATORS_PER_DAY_LIMIT = 43200;
// Must match the current value https://docs.lido.fi/guides/verify-lido-v2-upgrade-manual/#oraclereportsanitychecker
const ANNUAL_BALANCE_INCREASE_BP_LIMIT = 1000;
const SIMULATED_SHARE_RATE_DEVIATION_BP_LIMIT = 50;
const MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT = 600;
// The optimal number of items is greater than 6 (2 items for stuck or exited keys per 3 modules) to ensure
// a small report can fit into a single transaction. However, there is additional capacity in case a module
// requires more than 2 items. Hence, the limit of 8 items per report was chosen.
const MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION = 8;
// This parameter defines the maximum number of node operators that can be reported per extra data list item.
// Gas consumption for updating a single node operator:
//
// - CSM:
//   Average: ~16,650 gas
//   Max: ~41,150 gas (in cases with unstuck keys under specific conditions)
// - Curated-based: ~15,500 gas
//
// Each transaction can contain up to 8 items, and each item is limited to a maximum of 1,000,000 gas.
// Thus, the total gas consumption per transaction remains within 8,000,000 gas.
// Using the higher value of CSM (41,150 gas), the calculation is as follows:
//
// Operators per item: 1,000,000 / 41,150 = 24.3
// Thus, the limit was set at 24 operators per item.
const MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM = 24;
// Must match the current value https://docs.lido.fi/guides/verify-lido-v2-upgrade-manual/#oraclereportsanitychecker
const REQUEST_TIMESTAMP_MARGIN = 7680;
const MAX_POSITIVE_TOKEN_REBASE = 750000;
// Must match the value in LIP-23 https://github.com/lidofinance/lido-improvement-proposals/blob/develop/LIPS/lip-23.md
// and the proposed number on the research forum https://research.lido.fi/t/staking-router-community-staking-module-upgrade-announcement/8612
const INITIAL_SLASHING_AMOUNT_P_WEI = 1000;
const INACTIVITY_PENALTIES_AMOUNT_P_WEI = 101;
// Must match the proposed number on the research forum https://research.lido.fi/t/staking-router-community-staking-module-upgrade-announcement/8612
const CL_BALANCE_ORACLES_ERROR_UPPER_BP_LIMIT = 50;
const LIMITS = [
    EXITED_VALIDATORS_PER_DAY_LIMIT,
    APPEARED_VALIDATORS_PER_DAY_LIMIT,
    ANNUAL_BALANCE_INCREASE_BP_LIMIT,
    SIMULATED_SHARE_RATE_DEVIATION_BP_LIMIT,
    MAX_VALIDATOR_EXIT_REQUESTS_PER_REPORT,
    MAX_ITEMS_PER_EXTRA_DATA_TRANSACTION,
    MAX_NODE_OPERATORS_PER_EXTRA_DATA_ITEM,
    REQUEST_TIMESTAMP_MARGIN,
    MAX_POSITIVE_TOKEN_REBASE,
    INITIAL_SLASHING_AMOUNT_P_WEI,
    INACTIVITY_PENALTIES_AMOUNT_P_WEI,
    CL_BALANCE_ORACLES_ERROR_UPPER_BP_LIMIT,
];
async function main() {
    const deployer = hardhat_1.ethers.getAddress(getEnvVariable("DEPLOYER"));
    const chainId = (await hardhat_1.ethers.provider.getNetwork()).chainId;
    (0, lib_1.log)((0, lib_1.cy)(`Deploy of contracts on chain ${chainId}`));
    const state = (0, lib_1.readNetworkState)();
    (0, lib_1.persistNetworkState)(state);
    // Read contracts addresses from config
    const APP_AGENT_ADDRESS = state[lib_1.Sk.appAgent].proxy.address;
    const SC_ADMIN = APP_AGENT_ADDRESS;
    const locatorImplContract = await (0, lib_1.loadContract)("LidoLocator", typechain_types_1.INTERMEDIATE_LOCATOR_IMPL);
    const ACCOUNTING_ORACLE_PROXY = await locatorImplContract.accountingOracle();
    const VEBO = await locatorImplContract.validatorsExitBusOracle();
    const WITHDRAWAL_VAULT = await locatorImplContract.withdrawalVault();
    // Deploy ValidatorExitBusOracle
    const validatorsExitBusOracle = (await (0, lib_1.deployWithoutProxy)(lib_1.Sk.validatorsExitBusOracle, "ValidatorsExitBusOracle", deployer)).address;
    lib_1.log.success(`ValidatorsExitBusOracle address: ${validatorsExitBusOracle}`);
    lib_1.log.emptyLine();
    // Deploy WithdrawalVault
    const withdrawalVault = (await (0, lib_1.deployImplementation)(lib_1.Sk.withdrawalVault, "WithdrawalVault", deployer, [], { libraries })).address;
    lib_1.log.success(`WithdrawalVault address implementation: ${withdrawalVault}`);
    lib_1.log.emptyLine();
    (0, lib_1.updateObjectInState)(lib_1.Sk.appSimpleDvt, {
        implementation: {
            contract: "contracts/0.4.24/nos/NodeOperatorsRegistry.sol",
            address: appNodeOperatorsRegistry,
            constructorArgs: [],
        },
    });
    // Deploy DSM
    const depositSecurityModuleParams = [
        LIDO,
        DEPOSIT_CONTRACT_ADDRESS,
        STAKING_ROUTER,
        PAUSE_INTENT_VALIDITY_PERIOD_BLOCKS,
        MAX_OPERATORS_PER_UNVETTING,
    ];
    const depositSecurityModuleAddress = (await (0, lib_1.deployWithoutProxy)(lib_1.Sk.depositSecurityModule, "DepositSecurityModule", deployer, depositSecurityModuleParams)).address;
    lib_1.log.success(`New DSM address: ${depositSecurityModuleAddress}`);
    lib_1.log.emptyLine();
    const dsmContract = await (0, lib_1.loadContract)("DepositSecurityModule", depositSecurityModuleAddress);
    await dsmContract.addGuardians(GUARDIANS, QUORUM);
    await dsmContract.setOwner(APP_AGENT_ADDRESS);
    lib_1.log.success(`Guardians list: ${await dsmContract.getGuardians()}`);
    lib_1.log.success(`Quorum: ${await dsmContract.getGuardianQuorum()}`);
    lib_1.log.emptyLine();
    // Deploy AO
    const accountingOracleArgs = [LOCATOR, LIDO, LEGACY_ORACLE, SECONDS_PER_SLOT, GENESIS_TIME];
    const accountingOracleAddress = (await (0, lib_1.deployImplementation)(lib_1.Sk.accountingOracle, "AccountingOracle", deployer, accountingOracleArgs)).address;
    lib_1.log.success(`AO implementation address: ${accountingOracleAddress}`);
    lib_1.log.emptyLine();
    // Deploy OracleReportSanityCheckerArgs
    const oracleReportSanityCheckerArgs = [LOCATOR, SC_ADMIN, LIMITS];
    const oracleReportSanityCheckerAddress = (await (0, lib_1.deployWithoutProxy)(lib_1.Sk.oracleReportSanityChecker, "OracleReportSanityChecker", deployer, oracleReportSanityCheckerArgs)).address;
    lib_1.log.success(`OracleReportSanityChecker new address ${oracleReportSanityCheckerAddress}`);
    lib_1.log.emptyLine();
    const locatorConfig = [
        [
            ACCOUNTING_ORACLE_PROXY,
            depositSecurityModuleAddress,
            EL_REWARDS_VAULT,
            LEGACY_ORACLE,
            LIDO,
            oracleReportSanityCheckerAddress,
            POST_TOKEN_REBASE_RECEIVER,
            BURNER,
            STAKING_ROUTER,
            TREASURY_ADDRESS,
            VEBO,
            WQ,
            WITHDRAWAL_VAULT,
            ORACLE_DAEMON_CONFIG,
        ],
    ];
    const locatorAddress = (await (0, lib_1.deployImplementation)(lib_1.Sk.lidoLocator, "LidoLocator", deployer, locatorConfig)).address;
    lib_1.log.success(`Locator implementation address ${locatorAddress}`);
    lib_1.log.emptyLine();
    if (getEnvVariable("RUN_ON_FORK", "false") === "true") {
        (0, lib_1.log)((0, lib_1.cy)("Deploy script was executed on fork, will skip verification"));
        return;
    }
    await waitForPressButton();
    (0, lib_1.log)((0, lib_1.cy)("Continuing..."));
    await (0, hardhat_1.run)("verify:verify", {
        address: minFirstAllocationStrategyAddress,
        constructorArguments: [],
        contract: "contracts/common/lib/MinFirstAllocationStrategy.sol:MinFirstAllocationStrategy",
    });
    await (0, hardhat_1.run)("verify:verify", {
        address: stakingRouterAddress,
        constructorArguments: [DEPOSIT_CONTRACT_ADDRESS],
        libraries: {
            MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
        },
        contract: "contracts/0.8.9/StakingRouter.sol:StakingRouter",
    });
    await (0, hardhat_1.run)("verify:verify", {
        address: appNodeOperatorsRegistry,
        constructorArguments: [],
        libraries: {
            MinFirstAllocationStrategy: minFirstAllocationStrategyAddress,
        },
        contract: "contracts/0.4.24/nos/NodeOperatorsRegistry.sol:NodeOperatorsRegistry",
    });
    await (0, hardhat_1.run)("verify:verify", {
        address: depositSecurityModuleAddress,
        constructorArguments: depositSecurityModuleParams,
        contract: "contracts/0.8.9/DepositSecurityModule.sol:DepositSecurityModule",
    });
    await (0, hardhat_1.run)("verify:verify", {
        address: accountingOracleAddress,
        constructorArguments: accountingOracleArgs,
        contract: "contracts/0.8.9/oracle/AccountingOracle.sol:AccountingOracle",
    });
    await (0, hardhat_1.run)("verify:verify", {
        address: oracleReportSanityCheckerAddress,
        constructorArguments: oracleReportSanityCheckerArgs,
        contract: "contracts/0.8.9/sanity_checks/OracleReportSanityChecker.sol:OracleReportSanityChecker",
    });
    await (0, hardhat_1.run)("verify:verify", {
        address: locatorAddress,
        constructorArguments: locatorConfig,
        contract: "contracts/0.8.9/LidoLocator.sol:LidoLocator",
    });
}
async function waitForPressButton() {
    return new Promise((resolve) => {
        (0, lib_1.log)((0, lib_1.cy)("When contracts will be ready for verification step, press Enter to continue..."));
        const rl = readline_1.default.createInterface({ input: process.stdin });
        rl.on("line", () => {
            rl.close();
            resolve();
        });
    });
}
function getLocatorAddressesToString(ACCOUNTING_ORACLE_PROXY, EL_REWARDS_VAULT, LEGACY_ORACLE, LIDO, POST_TOKEN_REBASE_RECEIVER, BURNER, STAKING_ROUTER, TREASURY_ADDRESS, VEBO, WQ, WITHDRAWAL_VAULT, ORACLE_DAEMON_CONFIG) {
    return [
        `ACCOUNTING_ORACLE_PROXY: ${ACCOUNTING_ORACLE_PROXY}`,
        `EL_REWARDS_VAULT: ${EL_REWARDS_VAULT}`,
        `LEGACY_ORACLE: ${LEGACY_ORACLE}`,
        `LIDO: ${LIDO}`,
        `POST_TOKEN_REBASE_RECEIVER: ${POST_TOKEN_REBASE_RECEIVER}`,
        `BURNER: ${BURNER}`,
        `STAKING_ROUTER: ${STAKING_ROUTER}`,
        `TREASURY_ADDRESS: ${TREASURY_ADDRESS}`,
        `VEBO: ${VEBO}`,
        `WQ: ${WQ}`,
        `WITHDRAWAL_VAULT: ${WITHDRAWAL_VAULT}`,
        `ORACLE_DAEMON_CONFIG: ${ORACLE_DAEMON_CONFIG}`,
    ];
}
main()
    .then(() => process.exit(0))
    .catch((error) => {
    lib_1.log.error(error);
    process.exit(1);
});
