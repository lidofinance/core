import { TransactionReceipt } from "ethers";
import fs from "fs";

import * as toml from "@iarna/toml";

import { IDualGovernance, IEmergencyProtectedTimelock, OmnibusBase, TokenManager, Voting } from "typechain-types";

import { advanceChainTime, ether, log } from "lib";
import { impersonate } from "lib/account";
import { loadContract } from "lib/contract";
import { findEventsWithInterfaces } from "lib/event";
import { DeploymentState, getAddress, Sk } from "lib/state-file";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;

export interface UpgradeParameters {
  chainSpec: {
    slotsPerEpoch: number;
    secondsPerSlot: number;
    genesisTime: number;
    depositContract: string;
  };
  gateSealForVaults: {
    address: string;
  };
  validatorExitDelayVerifier: {
    gIFirstValidatorPrev: string;
    gIFirstValidatorCurr: string;
    gIFirstHistoricalSummaryPrev: string;
    gIFirstHistoricalSummaryCurr: string;
    gIFirstBlockRootInSummaryPrev: string;
    gIFirstBlockRootInSummaryCurr: string;
  };
  vaultHub: {
    relativeShareLimitBP: number;
  };
  lazyOracle: {
    quarantinePeriod: number;
    maxRewardRatioBP: number;
  };
  predepositGuarantee: {
    genesisForkVersion: string;
    gIndex: string;
    gIndexAfterChange: string;
    changeSlot: number;
  };
  delegation: {
    wethContract: string;
  };
  operatorGrid: {
    defaultTierParams: {
      shareLimitInEther: string;
      reserveRatioBP: number;
      forcedRebalanceThresholdBP: number;
      infraFeeBP: number;
      liquidityFeeBP: number;
      reservationFeeBP: number;
    };
  };
  burner: {
    isMigrationAllowed: boolean;
  };
  oracleVersions: {
    vebo_consensus_version: number;
    ao_consensus_version: number;
  };
  aragonAppVersions: {
    nor_version: number[];
    sdvt_version: number[];
  };
  triggerableWithdrawalsGateway: {
    maxExitRequestsLimit: number;
    exitsPerFrame: number;
    frameDurationInSec: number;
  };
  triggerableWithdrawals: {
    exit_events_lookback_window_in_slots: number;
    nor_exit_deadline_in_sec: number;
  };
}

export function readUpgradeParameters(): UpgradeParameters {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  const rawData = fs.readFileSync(UPGRADE_PARAMETERS_FILE, "utf8");
  return toml.parse(rawData) as unknown as UpgradeParameters;
}

export async function mockDGAragonVoting(
  omnibusScriptAddress: string,
  description: string,
  proposalMetadata: string,
  state: DeploymentState,
): Promise<{
  voteId: bigint;
  proposalId: bigint;
  executeReceipt: TransactionReceipt;
  scheduleReceipt: TransactionReceipt;
  proposalExecutedReceipt: TransactionReceipt;
}> {
  log("Starting mock Aragon voting...");
  const agentAddress = getAddress(Sk.appAgent, state);
  const votingAddress = getAddress(Sk.appVoting, state);
  const tokenManagerAddress = getAddress(Sk.appTokenManager, state);

  const deployer = await impersonate(agentAddress, ether("100"));
  const tokenManager = await loadContract<TokenManager>("TokenManager", tokenManagerAddress);
  const voting = await loadContract<Voting>("Voting", votingAddress);
  const timelock = await loadContract<IEmergencyProtectedTimelock>(
    "IEmergencyProtectedTimelock",
    state[Sk.dgEmergencyProtectedTimelock].proxy.address,
  );
  const afterSubmitDelay = await timelock.getAfterSubmitDelay();
  const afterScheduleDelay = await timelock.getAfterScheduleDelay();

  const voteId = await voting.votesLength();

  const voteScript = await loadContract<OmnibusBase>("OmnibusBase", omnibusScriptAddress);
  const voteBytecode = await voteScript.getNewVoteCallBytecode(description, proposalMetadata);

  await tokenManager.connect(deployer).forward(voteBytecode);
  if (!(await voteScript.isValidVoteScript(voteId, proposalMetadata))) throw new Error("Vote script is not valid");
  await voting.connect(deployer).vote(voteId, true, false);
  await advanceChainTime(await voting.voteTime());
  const executeTx = await voting.executeVote(voteId);
  const executeReceipt = (await executeTx.wait())!;
  log.success("Voting executed: gas used", executeReceipt.gasUsed);

  const dualGovernance = await loadContract<IDualGovernance>(
    "IDualGovernance",
    state[Sk.dgDualGovernance].proxy.address,
  );
  const events = findEventsWithInterfaces(executeReceipt, "ProposalSubmitted", [dualGovernance.interface]);
  const proposalId = events[0].args.id;
  log.success("Proposal submitted: proposalId", proposalId);

  await advanceChainTime(afterSubmitDelay);
  const scheduleTx = await dualGovernance.connect(deployer).scheduleProposal(proposalId);
  const scheduleReceipt = (await scheduleTx.wait())!;
  log.success("Proposal scheduled: gas used", scheduleReceipt.gasUsed);

  await advanceChainTime(afterScheduleDelay);
  const proposalExecutedTx = await timelock.connect(deployer).execute(proposalId);
  const proposalExecutedReceipt = (await proposalExecutedTx.wait())!;
  log.success("Proposal executed: gas used", proposalExecutedReceipt.gasUsed);

  return { voteId, proposalId, executeReceipt, scheduleReceipt, proposalExecutedReceipt };
}
