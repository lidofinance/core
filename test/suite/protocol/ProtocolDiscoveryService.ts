import * as process from "node:process";

import { BaseContract } from "ethers";
import hre from "hardhat";

import {
  AccountingOracle,
  Burner,
  DepositSecurityModule,
  LegacyOracle,
  Lido,
  LidoExecutionLayerRewardsVault,
  LidoLocator,
  OracleDaemonConfig,
  OracleReportSanityChecker,
  StakingRouter,
  ValidatorsExitBusOracle,
  WithdrawalQueueERC721,
  WithdrawalVault,
} from "typechain-types";

import { batch } from "lib";

import { Contracts, LoadedContract } from "./Contracts";

export abstract class ProtocolDiscoveryService {
  public readonly locatorAddress: string;
  public contracts?: Contracts;

  protected readonly agentAddress: string;
  protected readonly votingAddress: string;

  protected constructor() {
    if (this.isLocalNetwork()) {
      this.locatorAddress = process.env.LOCAL_LOCATOR_ADDRESS || "";
      this.agentAddress = process.env.LOCAL_AGENT_ADDRESS || "";
      this.votingAddress = process.env.LOCAL_VOTING_ADDRESS || "";
    } else if (this.isMainnetForkNetwork()) {
      this.locatorAddress = process.env.MAINNET_LOCATOR_ADDRESS || "";
      this.agentAddress = process.env.MAINNET_AGENT_ADDRESS || "";
      this.votingAddress = process.env.MAINNET_VOTING_ADDRESS || "";
    } else {
      throw new Error("Unsupported network");
    }

    const error = (address: string, vars: string) => {
      return `${address} address is not set, please set it in the environment variables: ${vars}`;
    };

    if (!this.locatorAddress) throw new Error(error("Locator", "LOCAL_LOCATOR_ADDRESS, MAINNET_LOCATOR_ADDRESS"));
    if (!this.agentAddress) throw new Error(error("Agent", "LOCAL_AGENT_ADDRESS, MAINNET_AGENT_ADDRESS"));
    if (!this.votingAddress) throw new Error(error("Voting", "LOCAL_VOTING_ADDRESS, MAINNET_VOTING_ADDRESS"));
  }

  async locator(): Promise<LidoLocator> {
    return await hre.ethers.getContractAt("LidoLocator", this.locatorAddress!);
  }

  async discover() {
    const locator = await this.locator();

    if (this.contracts) {
      return this.contracts;
    }

    this.contracts = await batch({
      accountingOracle: this.loadContract<AccountingOracle>("AccountingOracle", await locator.accountingOracle()),
      depositSecurityModule: this.loadContract<DepositSecurityModule>(
        "DepositSecurityModule",
        await locator.depositSecurityModule(),
      ),
      elRewardsVault: this.loadContract<LidoExecutionLayerRewardsVault>(
        "LidoExecutionLayerRewardsVault",
        await locator.elRewardsVault(),
      ),
      legacyOracle: this.loadContract<LegacyOracle>("LegacyOracle", await locator.legacyOracle()),
      lido: this.loadContract<Lido>("Lido", await locator.lido()),
      oracleReportSanityChecker: this.loadContract<OracleReportSanityChecker>(
        "OracleReportSanityChecker",
        await locator.oracleReportSanityChecker(),
      ),
      burner: this.loadContract<Burner>("Burner", await locator.burner()),
      stakingRouter: this.loadContract<StakingRouter>("StakingRouter", await locator.stakingRouter()),
      validatorsExitBusOracle: this.loadContract<ValidatorsExitBusOracle>(
        "ValidatorsExitBusOracle",
        await locator.validatorsExitBusOracle(),
      ),
      withdrawalQueue: this.loadContract<WithdrawalQueueERC721>(
        "WithdrawalQueueERC721",
        await locator.withdrawalQueue(),
      ),
      withdrawalVault: this.loadContract<WithdrawalVault>("WithdrawalVault", await locator.withdrawalVault()),
      oracleDaemonConfig: this.loadContract<OracleDaemonConfig>(
        "OracleDaemonConfig",
        await locator.oracleDaemonConfig(),
      ),
      postTokenRebaseReceiverAddress: locator.postTokenRebaseReceiver(),
      treasuryAddress: locator.treasury(),
    });

    return this.contracts as Contracts;
  }

  private async loadContract<ContractType extends BaseContract>(name: string, address: string) {
    const contract = await hre.ethers.getContractAt(name, address);

    return contract as unknown as LoadedContract<ContractType>;
  }

  public isLocalNetwork(): boolean {
    return hre.network.name === "local";
  }

  public isMainnetForkNetwork(): boolean {
    return hre.network.name === "mainnet-fork";
  }
}
