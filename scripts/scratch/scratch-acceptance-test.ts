import { assert } from "chai";
import { ethers } from "hardhat";

import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { setBalance } from "@nomicfoundation/hardhat-network-helpers";

import {
  AccountingOracle,
  Agent,
  DepositSecurityModule,
  HashConsensus,
  Lido,
  LidoExecutionLayerRewardsVault,
  MiniMeToken,
  NodeOperatorsRegistry,
  StakingRouter,
  Voting,
  WithdrawalQueue,
} from "typechain-types";

import { loadContract, LoadedContract } from "lib/contract";
import { findEvents } from "lib/event";
import { streccak } from "lib/keccak";
import { log } from "lib/log";
import { reportOracle } from "lib/oracle";
import { DeploymentState, getAddress, readNetworkState, Sk } from "lib/state-file";
import { advanceChainTime } from "lib/time";
import { ether } from "lib/units";

const UNLIMITED_STAKING_LIMIT = 1000000000;
const CURATED_MODULE_ID = 1;
const DEPOSIT_CALLDATA = "0x00";
const MAX_DEPOSITS = 150;
const ADDRESS_1 = "0x0000000000000000000000000000000000000001";
const ADDRESS_2 = "0x0000000000000000000000000000000000000002";

const MANAGE_MEMBERS_AND_QUORUM_ROLE = streccak("MANAGE_MEMBERS_AND_QUORUM_ROLE");

if (!process.env.HARDHAT_FORKING_URL) {
  log.error("Env variable HARDHAT_FORKING_URL must be set to run fork acceptance tests");
  process.exit(1);
}
if (!process.env.NETWORK_STATE_FILE) {
  log.error("Env variable NETWORK_STATE_FILE must be set to run fork acceptance tests");
  process.exit(1);
}
const NETWORK_STATE_FILE = process.env.NETWORK_STATE_FILE;

async function main() {
  log.scriptStart(__filename);
  const state = readNetworkState({ networkStateFile: NETWORK_STATE_FILE });

  const [user1, user2, oracleMember1, oracleMember2] = await ethers.getSigners();
  const protocol = await loadDeployedProtocol(state);

  await checkLdoCanBeTransferred(protocol.ldo, state);

  await prepareProtocolForSubmitDepositReportWithdrawalFlow(
    protocol,
    await oracleMember1.getAddress(),
    await oracleMember2.getAddress(),
  );
  await checkSubmitDepositReportWithdrawal(protocol, state, user1, user2);
  log.scriptFinish(__filename);
}

interface Protocol {
  stakingRouter: LoadedContract<StakingRouter>;
  lido: LoadedContract<Lido>;
  voting: LoadedContract<Voting>;
  agent: LoadedContract<Agent>;
  nodeOperatorsRegistry: LoadedContract<NodeOperatorsRegistry>;
  depositSecurityModule?: LoadedContract<DepositSecurityModule>;
  depositSecurityModuleAddress: string;
  accountingOracle: LoadedContract<AccountingOracle>;
  hashConsensusForAO: LoadedContract<HashConsensus>;
  elRewardsVault: LoadedContract<LidoExecutionLayerRewardsVault>;
  withdrawalQueue: LoadedContract<WithdrawalQueue>;
  ldo: LoadedContract<MiniMeToken>;
}

async function loadDeployedProtocol(state: DeploymentState) {
  return {
    stakingRouter: await loadContract<StakingRouter>("StakingRouter", getAddress(Sk.stakingRouter, state)),
    lido: await loadContract<Lido>("Lido", getAddress(Sk.appLido, state)),
    voting: await loadContract<Voting>("Voting", getAddress(Sk.appVoting, state)),
    agent: await loadContract<Agent>("Agent", getAddress(Sk.appAgent, state)),
    nodeOperatorsRegistry: await loadContract<NodeOperatorsRegistry>(
      "NodeOperatorsRegistry",
      getAddress(Sk.appNodeOperatorsRegistry, state),
    ),
    depositSecurityModuleAddress: getAddress(Sk.depositSecurityModule, state),
    accountingOracle: await loadContract<AccountingOracle>("AccountingOracle", getAddress(Sk.accountingOracle, state)),
    hashConsensusForAO: await loadContract<HashConsensus>(
      "HashConsensus",
      getAddress(Sk.hashConsensusForAccountingOracle, state),
    ),
    elRewardsVault: await loadContract<LidoExecutionLayerRewardsVault>(
      "LidoExecutionLayerRewardsVault",
      getAddress(Sk.executionLayerRewardsVault, state),
    ),
    withdrawalQueue: await loadContract<WithdrawalQueue>(
      "WithdrawalQueue",
      getAddress(Sk.withdrawalQueueERC721, state),
    ),
    ldo: await loadContract<MiniMeToken>("MiniMeToken", getAddress(Sk.ldo, state)),
  };
}

async function checkLdoCanBeTransferred(ldo: LoadedContract<MiniMeToken>, state: DeploymentState) {
  const ldoHolder = Object.keys(state.vestingParams.holders)[0];
  const ldoHolderSigner = await ethers.provider.getSigner(ldoHolder);
  await setBalance(ldoHolder, ether("10"));
  await ethers.provider.send("hardhat_impersonateAccount", [ldoHolder]);
  await ldo.connect(ldoHolderSigner).transfer(ADDRESS_1, ether("1"));
  assert.equal(await ldo.balanceOf(ADDRESS_1), ether("1"));
  log.success("Transferred LDO");
}

async function prepareProtocolForSubmitDepositReportWithdrawalFlow(
  protocol: Protocol,
  oracleMember1: string,
  oracleMember2: string,
) {
  const {
    lido,
    voting,
    agent,
    nodeOperatorsRegistry,
    depositSecurityModuleAddress,
    hashConsensusForAO,
    withdrawalQueue,
  } = protocol;

  await ethers.provider.send("hardhat_impersonateAccount", [voting.address]);
  await ethers.provider.send("hardhat_impersonateAccount", [depositSecurityModuleAddress]);
  await ethers.provider.send("hardhat_impersonateAccount", [agent.address]);
  await setBalance(voting.address, ether("10"));
  await setBalance(agent.address, ether("10"));
  await setBalance(depositSecurityModuleAddress, ether("10"));
  const votingSigner = await ethers.provider.getSigner(voting.address);
  const agentSigner = await ethers.provider.getSigner(agent.address);

  const RESUME_ROLE = await withdrawalQueue.RESUME_ROLE();

  await lido.connect(votingSigner).resume();

  await withdrawalQueue.connect(agentSigner).grantRole(RESUME_ROLE, agent.address);
  await withdrawalQueue.connect(agentSigner).resume();
  await withdrawalQueue.connect(agentSigner).renounceRole(RESUME_ROLE, agent.address);

  await nodeOperatorsRegistry.connect(agentSigner).addNodeOperator("1", ADDRESS_1);
  await nodeOperatorsRegistry.connect(agentSigner).addNodeOperator("2", ADDRESS_2);

  const pad = ethers.zeroPadValue;
  await nodeOperatorsRegistry.connect(votingSigner).addSigningKeys(0, 1, pad("0x010203", 48), pad("0x01", 96));
  await nodeOperatorsRegistry
    .connect(votingSigner)
    .addSigningKeys(
      0,
      3,
      ethers.concat([pad("0x010204", 48), pad("0x010205", 48), pad("0x010206", 48)]),
      ethers.concat([pad("0x01", 96), pad("0x01", 96), pad("0x01", 96)]),
    );

  await nodeOperatorsRegistry.connect(votingSigner).setNodeOperatorStakingLimit(0, UNLIMITED_STAKING_LIMIT);
  await nodeOperatorsRegistry.connect(votingSigner).setNodeOperatorStakingLimit(1, UNLIMITED_STAKING_LIMIT);

  const quorum = 2;
  await hashConsensusForAO.connect(agentSigner).grantRole(MANAGE_MEMBERS_AND_QUORUM_ROLE, agent.address);
  await hashConsensusForAO.connect(agentSigner).addMember(oracleMember1, quorum);
  await hashConsensusForAO.connect(agentSigner).addMember(oracleMember2, quorum);
  await hashConsensusForAO.connect(agentSigner).renounceRole(MANAGE_MEMBERS_AND_QUORUM_ROLE, agent.address);

  log.success("Protocol prepared for submit-deposit-report-withdraw flow");
}

async function checkSubmitDepositReportWithdrawal(
  protocol: Protocol,
  state: DeploymentState,
  user1: HardhatEthersSigner,
  user2: HardhatEthersSigner,
) {
  const {
    lido,
    agent,
    depositSecurityModuleAddress,
    accountingOracle,
    hashConsensusForAO,
    elRewardsVault,
    withdrawalQueue,
  } = protocol;

  const initialLidoBalance = await ethers.provider.getBalance(lido.address);
  const chainSpec = state.chainSpec;
  const genesisTime = BigInt(chainSpec.genesisTime);
  const slotsPerEpoch = BigInt(chainSpec.slotsPerEpoch);
  const secondsPerSlot = BigInt(chainSpec.secondsPerSlot);
  const depositSecurityModuleSigner = await ethers.provider.getSigner(depositSecurityModuleAddress as string);
  const agentSigner = await ethers.provider.getSigner(agent.address);

  await user1.sendTransaction({ to: lido.address, value: ether("34") });
  await user2.sendTransaction({ to: elRewardsVault.address, value: ether("1") });
  log.success("Users submitted ether");

  assert.equal(await lido.balanceOf(user1.address), ether("34"));
  assert.equal(await lido.getTotalPooledEther(), initialLidoBalance + BigInt(ether("34")));
  assert.equal(await lido.getBufferedEther(), initialLidoBalance + BigInt(ether("34")));

  await lido.connect(depositSecurityModuleSigner).deposit(MAX_DEPOSITS, CURATED_MODULE_ID, DEPOSIT_CALLDATA);
  log.success("Ether deposited");

  assert.equal((await lido.getBeaconStat()).depositedValidators, 1n);

  const latestBlock = await ethers.provider.getBlock("latest");
  if (latestBlock === null) {
    throw new Error(`Failed with ethers.provider.getBlock("latest")`);
  }
  const latestBlockTimestamp = BigInt(latestBlock.timestamp);
  const initialEpoch = (latestBlockTimestamp - genesisTime) / (slotsPerEpoch * secondsPerSlot);

  await hashConsensusForAO.connect(agentSigner).updateInitialEpoch(initialEpoch);

  const elRewardsVaultBalance = await ethers.provider.getBalance(elRewardsVault.address);

  const withdrawalAmount = ether("1");

  await lido.connect(user1).approve(withdrawalQueue.address, withdrawalAmount);
  const tx = await withdrawalQueue.connect(user1).requestWithdrawals([withdrawalAmount], user1.address);
  const receipt = await tx.wait();
  if (receipt === null) {
    throw new Error(`Failed with:\n${tx}`);
  }

  const requestId = findEvents(receipt, "WithdrawalRequested")[0].args.requestId;

  log.success("Withdrawal request made");

  const epochsPerFrame = (await hashConsensusForAO.getFrameConfig()).epochsPerFrame;
  const initialEpochTimestamp = genesisTime + initialEpoch * slotsPerEpoch * secondsPerSlot;

  // skip two reports to be sure about REQUEST_TIMESTAMP_MARGIN
  const nextReportEpochTimestamp = initialEpochTimestamp + 2n * epochsPerFrame * slotsPerEpoch * secondsPerSlot;

  const timeToWaitTillReportWindow = nextReportEpochTimestamp - latestBlockTimestamp + secondsPerSlot;

  await advanceChainTime(parseInt(timeToWaitTillReportWindow.toString()));

  const stat = await lido.getBeaconStat();
  const clBalance = BigInt(stat.depositedValidators) * ether("32");

  const { refSlot } = await hashConsensusForAO.getCurrentFrame();
  const reportTimestamp = genesisTime + refSlot * secondsPerSlot;
  const timeElapsed = nextReportEpochTimestamp - initialEpochTimestamp;

  const withdrawalFinalizationBatches = [1];

  const accountingOracleSigner = await ethers.provider.getSigner(accountingOracle.address);
  // Performing dry-run to estimate simulated share rate
  const [postTotalPooledEther, postTotalShares] = await lido
    .connect(accountingOracleSigner)
    .handleOracleReport.staticCall(
      reportTimestamp,
      timeElapsed,
      stat.depositedValidators,
      clBalance,
      0 /* withdrawals vault balance */,
      elRewardsVaultBalance,
      0 /* shares requested to burn */,
      [] /* withdrawal finalization batches */,
      0 /* simulated share rate */,
    );

  log.success("Oracle report simulated");

  const simulatedShareRate = (postTotalPooledEther * 10n ** 27n) / postTotalShares;

  await reportOracle(hashConsensusForAO, accountingOracle, {
    refSlot,
    numValidators: stat.depositedValidators,
    clBalance,
    elRewardsVaultBalance,
    withdrawalFinalizationBatches,
    simulatedShareRate,
  });

  log.success("Oracle report submitted");

  await withdrawalQueue.connect(user1).claimWithdrawalsTo([requestId], [requestId], user1.address);

  log.success("Withdrawal claimed successfully");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    log.error(error);
    process.exit(1);
  });
