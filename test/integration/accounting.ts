import { expect } from "chai";
import { assert } from "console";
import { ContractTransactionReceipt, Result, TransactionResponse, ZeroAddress } from "ethers";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { IHashConsensus } from "typechain-types";

import { advanceChainTime, batch, ether, findEventsWithInterfaces, impersonate, log, trace } from "lib";
import { getProtocolContext, ProtocolContext } from "lib/protocol";
import { ensureSDVTOperators, oracleReport, unpauseStaking, unpauseWithdrawalQueue } from "lib/protocol/helpers";

import { Snapshot } from "test/suite";

const LIMITER_PRECISION_BASE = 10 ** 9;
const MAX_BASIS_POINTS = 10_000;
const ONE_DAY = 1 * 24 * 60 * 60;

const GWEI = BigInt(1e9); // 1 GWEI in Wei
const EXTRA_DATA_FORMAT_EMPTY = 0; // Define as per your requirement
const ZERO_BYTES32 = "0x0000000000000000000000000000000000000000000000000000000000000000";

describe("Protocol", () => {
  let ctx: ProtocolContext;
  let snapshot: string;

  let ethHolder: HardhatEthersSigner;
  let stEthHolder: HardhatEthersSigner;
  let stranger: HardhatEthersSigner;

  let uncountedStETHShares: bigint;
  let amountWithRewards: bigint;

  before(async () => {
    ctx = await getProtocolContext();

    const signers = await ethers.getSigners();

    [ethHolder, stEthHolder, stranger] = await Promise.all([
      impersonate(signers[0].address, ether("1000000")),
      impersonate(signers[1].address, ether("1000000")),
      impersonate(signers[2].address, ether("1000000")),
    ]);

    snapshot = await Snapshot.take();
  });

  after(async () => await Snapshot.restore(snapshot));

  const getEvents = (receipt: ContractTransactionReceipt, eventName: string) => {
    return findEventsWithInterfaces(receipt, eventName, ctx.interfaces);
  };

  const submitStake = async (amount: bigint, wallet: HardhatEthersSigner) => {
    const { lido } = ctx.contracts;
    const tx = await lido.connect(wallet).submit(ZeroAddress, { value: amount });
    await trace("lido.submit", tx);
  };

  const getBalances = async (wallet: HardhatEthersSigner) => {
    const { lido } = ctx.contracts;
    return batch({
      ETH: ethers.provider.getBalance(wallet),
      stETH: lido.balanceOf(wallet),
    });
  };

  const waitToNextAvailableReportTime = async (consensusContract: IHashConsensus) => {
    const [SLOTS_PER_EPOCH, SECONDS_PER_SLOT, GENESIS_TIME] = await consensusContract.getChainConfig();
    const [refSlot] = await consensusContract.getCurrentFrame();
    const latestBlock = await ethers.provider.getBlock("latest");
    expect(latestBlock).to.not.be.null;
    const latestTime = BigInt(latestBlock!.timestamp);

    const [_, EPOCHS_PER_FRAME] = await consensusContract.getFrameConfig();
    const frameStartWithOffset = GENESIS_TIME + (refSlot + SLOTS_PER_EPOCH * EPOCHS_PER_FRAME + 1n) * SECONDS_PER_SLOT;
    const sleepDuration = frameStartWithOffset - latestTime;
    await advanceChainTime(Number(sleepDuration));

    const [nextRefSlot] = await consensusContract.getCurrentFrame();
    expect(nextRefSlot).to.equal(refSlot + SLOTS_PER_EPOCH * EPOCHS_PER_FRAME);
  }

  const simulateReport = async ({
    refSlot,
    beaconValidators,
    postCLBalance,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    blockIdentifier = null,
  }: {
    refSlot: bigint;
    beaconValidators: bigint;
    postCLBalance: bigint;
    withdrawalVaultBalance: bigint;
    elRewardsVaultBalance: bigint;
    blockIdentifier?: bigint | null;
  }) => {
    const [_, SECONDS_PER_SLOT, GENESIS_TIME] = await ctx.contracts.hashConsensus.getChainConfig();
    const reportTime = GENESIS_TIME + refSlot * SECONDS_PER_SLOT;

    if (blockIdentifier) {
      return await ctx.contracts.lido.handleOracleReport.staticCall(
        reportTime,
        ONE_DAY,
        beaconValidators,
        postCLBalance,
        withdrawalVaultBalance,
        elRewardsVaultBalance,
        0,
        [],
        0,
        { from: ctx.contracts.accountingOracle.address, blockTag: blockIdentifier });
    } else {
      return await ctx.contracts.lido.handleOracleReport.staticCall(
        reportTime,
        ONE_DAY,
        beaconValidators,
        postCLBalance,
        withdrawalVaultBalance,
        elRewardsVaultBalance,
        0,
        [],
        0,
        { from: ctx.contracts.accountingOracle.address });
    }
  }

  const prepareAccountingReport = async ({
    refSlot,
    clBalance,
    numValidators,
    withdrawalVaultBalance,
    elRewardsVaultBalance,
    sharesRequestedToBurn,
    simulatedShareRate,
    stakingModuleIdsWithNewlyExitedValidators = [],
    numExitedValidatorsByStakingModule = [],
    consensusVersion = 1,
    withdrawalFinalizationBatches = [],
    isBunkerMode = false,
    extraDataFormat = EXTRA_DATA_FORMAT_EMPTY,
    extraDataHash = ZERO_BYTES32,
    extraDataItemsCount = 0,
  }: {
    refSlot: bigint;
    clBalance: bigint;
    numValidators: bigint;
    withdrawalVaultBalance: bigint;
    elRewardsVaultBalance: bigint;
    sharesRequestedToBurn: bigint;
    simulatedShareRate: bigint;
    stakingModuleIdsWithNewlyExitedValidators?: bigint[];
    numExitedValidatorsByStakingModule?: bigint[];
    consensusVersion?: number;
    withdrawalFinalizationBatches?: bigint[];
    isBunkerMode?: boolean;
    extraDataFormat?: number;
    extraDataHash?: string;
    extraDataItemsCount?: number;
  }) => {
    const report = {
      consensusVersion: consensusVersion,
      refSlot: refSlot,
      numValidators: numValidators,
      clBalanceGwei: clBalance / GWEI,
      stakingModuleIdsWithNewlyExitedValidators: stakingModuleIdsWithNewlyExitedValidators,
      numExitedValidatorsByStakingModule: numExitedValidatorsByStakingModule,
      withdrawalVaultBalance: withdrawalVaultBalance,
      elRewardsVaultBalance: elRewardsVaultBalance,
      sharesRequestedToBurn: sharesRequestedToBurn,
      withdrawalFinalizationBatches: withdrawalFinalizationBatches.map((i) => i),
      simulatedShareRate: simulatedShareRate,
      isBunkerMode: isBunkerMode,
      extraDataFormat: extraDataFormat,
      extraDataHash: extraDataHash,
      extraDataItemsCount: extraDataItemsCount,
    };

    const reportHash = generateReportHash(report); // Implement this function as needed

    return { items: report, hash: reportHash };
  }


  // const oracleReport = async (clDiff: bigint = ether("10"), excludeVaultsBalances: boolean = false) => {
  // cl_diff = ETH(10),
  // cl_appeared_validators = 0,
  // exclude_vaults_balances = False,
  // report_el_vault = True,
  // elRewardsVaultBalance = None,
  // report_withdrawals_vault = True,
  // withdrawalVaultBalance = None,
  // simulation_block_identifier = None,
  // skip_withdrawals = False,
  // wait_to_next_report_time = True,
  // extraDataFormat = 0,
  // extraDataHash = ZERO_BYTES32,
  // extraDataItemsCount = 0,
  // extraDataList = b"",
  // stakingModuleIdsWithNewlyExitedValidators = [],
  // numExitedValidatorsByStakingModule = [],
  // silent = False,
  // sharesRequestedToBurn = None,
  // withdrawalFinalizationBatches = [],
  // simulatedShareRate = None,
  // refSlot = None,
  // dry_run = False,

  //     if wait_to_next_report_time:
  //       """fast forwards time to next report, compiles report, pushes through consensus and to AccountingOracle"""
  //     wait_to_next_available_report_time(contracts.hash_consensus_for_accounting_oracle)
  //     if refSlot is None:
  //     (refSlot, _) = contracts.hash_consensus_for_accounting_oracle.getCurrentFrame()

  //       (_, beaconValidators, beaconBalance) = contracts.lido.getBeaconStat()

  //     postCLBalance = beaconBalance + cl_diff
  //     print("postCLBalance", postCLBalance, beaconBalance, cl_diff)
  //     postBeaconValidators = beaconValidators + cl_appeared_validators

  //     elRewardsVaultBalance = (
  //       eth_balance(contracts.execution_layer_rewards_vault.address)
  //           if elRewardsVaultBalance is None
  //           else elRewardsVaultBalance
  //       )
  // withdrawalVaultBalance = (
  //   eth_balance(contracts.withdrawal_vault.address) if withdrawalVaultBalance is None else withdrawalVaultBalance
  //       )

  //       # exclude_vaults_balances safely forces LIDO to see vault balances as empty allowing zero / negative rebase
  //       # simulate_reports needs proper withdrawal and elRewards vaults balances
  // if exclude_vaults_balances:
  //   if not report_withdrawals_vault or not report_el_vault:
  // warnings.warn("exclude_vaults_balances overrides report_withdrawals_vault and report_el_vault")

  // report_withdrawals_vault = False
  // report_el_vault = False

  // if not report_withdrawals_vault:
  //   withdrawalVaultBalance = 0
  // if not report_el_vault:
  //   elRewardsVaultBalance = 0

  // if sharesRequestedToBurn is None:
  // (coverShares, nonCoverShares) = contracts.burner.getSharesRequestedToBurn()
  // sharesRequestedToBurn = coverShares + nonCoverShares

  // is_bunker = False

  // if not skip_withdrawals:
  //   (postTotalPooledEther, postTotalShares, withdrawals, elRewards) = simulate_report(
  //     refSlot = refSlot,
  //     beaconValidators = postBeaconValidators,
  //     postCLBalance = postCLBalance,
  //     withdrawalVaultBalance = withdrawalVaultBalance,
  //     elRewardsVaultBalance = elRewardsVaultBalance,
  //     block_identifier = simulation_block_identifier,
  //   )
  // if simulatedShareRate is None:
  // simulatedShareRate = postTotalPooledEther * SHARE_RATE_PRECISION // postTotalShares

  // withdrawalFinalizationBatches = (
  //   get_finalization_batches(simulatedShareRate, withdrawals, elRewards)
  //               if withdrawalFinalizationBatches == []
  //               else withdrawalFinalizationBatches
  //           )

  // preTotalPooledEther = contracts.lido.getTotalPooledEther()
  // is_bunker = preTotalPooledEther > postTotalPooledEther
  //       elif simulatedShareRate is None:
  // simulatedShareRate = 0

  // if dry_run:
  //   return AccountingReport(
  //     consensusVersion = contracts.accounting_oracle.getConsensusVersion(),
  //     refSlot = refSlot,
  //     numValidators = postBeaconValidators,
  //     clBalanceGwei = postCLBalance // GWEI,
  //               stakingModuleIdsWithNewlyExitedValidators = stakingModuleIdsWithNewlyExitedValidators,
  //     numExitedValidatorsByStakingModule = numExitedValidatorsByStakingModule,
  //     withdrawalVaultBalance = withdrawalVaultBalance,
  //     elRewardsVaultBalance = elRewardsVaultBalance,
  //     sharesRequestedToBurn = sharesRequestedToBurn,
  //     withdrawalFinalizationBatches = withdrawalFinalizationBatches,
  //     simulatedShareRate = simulatedShareRate,
  //     isBunkerMode = is_bunker,
  //     extraDataFormat = extraDataFormat,
  //     extraDataHash = extraDataHash,
  //     extraDataItemsCount = extraDataItemsCount,
  //   )

  // return push_oracle_report(
  //   refSlot = refSlot,
  //   clBalance = postCLBalance,
  //   numValidators = postBeaconValidators,
  //   withdrawalVaultBalance = withdrawalVaultBalance,
  //   sharesRequestedToBurn = sharesRequestedToBurn,
  //   withdrawalFinalizationBatches = withdrawalFinalizationBatches,
  //   elRewardsVaultBalance = elRewardsVaultBalance,
  //   simulatedShareRate = simulatedShareRate,
  //   extraDataFormat = extraDataFormat,
  //   extraDataHash = extraDataHash,
  //   extraDataItemsCount = extraDataItemsCount,
  //   extraDataList = extraDataList,
  //   stakingModuleIdsWithNewlyExitedValidators = stakingModuleIdsWithNewlyExitedValidators,
  //   numExitedValidatorsByStakingModule = numExitedValidatorsByStakingModule,
  //   silent = silent,
  //   isBunkerMode = is_bunker,
  // )
  //   }


  it("Should be unpaused", async () => {
    const { lido, accountingOracle } = ctx.contracts;

    const blockBeforeReport = await ethers.provider.getBlockNumber();
    // tx, _ = oracle_report(cl_diff=0, exclude_vaults_balances=True)
    const blockAfterReport = await ethers.provider.getBlockNumber();


  });

});
