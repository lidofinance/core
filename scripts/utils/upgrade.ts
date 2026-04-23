import {
  ContractTransactionReceipt,
  ContractTransactionResponse,
  Log,
  LogDescription,
  TransactionReceipt,
  TransactionResponse,
} from "ethers";
import fs from "fs";
import { getMode } from "hardhat.helpers";

import * as toml from "@iarna/toml";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import {
  IDualGovernance,
  ITimelock,
  Lido,
  StakingRouter,
  TokenManager,
  UpgradeTemplate,
  UpgradeVoteScript,
  Voting,
} from "typechain-types";

import {
  advanceChainTime,
  ConvertibleToString,
  ether,
  findEventsWithInterfaces,
  getCurrentBlockTimestamp,
  impersonate,
  log,
} from "lib";
import { UpgradeParameters, validateUpgradeParameters } from "lib/config-schemas";
import { loadContract, LoadedContract } from "lib/contract";
import { getTxLink } from "lib/explorer";
import { DeploymentState, getAddress, readNetworkState, Sk } from "lib/state-file";

import { FUSAKA_TX_GAS_LIMIT, ONE_HOUR } from "test/suite";

import { encodeCallScript, VoteItem } from "./omnibus";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;
const PROPOSAL_ID = process.env.PROPOSAL_ID || "";
const PROPOSAL_METADATA = process.env.PROPOSAL_METADATA || "proposal-metadata";
const SKIP_IF_CONTRACT_IN_STATE = !!process.env.SKIP_IF_CONTRACT_IN_STATE;

export { UpgradeParameters };

///
/// ---- Upgrade helpers ----
///
export function readUpgradeParameters(skipValidation: boolean = false): UpgradeParameters {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  if (!fs.existsSync(UPGRADE_PARAMETERS_FILE)) {
    throw new Error(`Upgrade parameters file not found: ${UPGRADE_PARAMETERS_FILE}`);
  }

  const rawData = fs.readFileSync(UPGRADE_PARAMETERS_FILE, "utf8");
  const parsedData = toml.parse(rawData);

  if (skipValidation) {
    return parsedData as UpgradeParameters;
  }

  try {
    return validateUpgradeParameters(parsedData);
  } catch (error) {
    throw new Error(`Invalid upgrade parameters (${UPGRADE_PARAMETERS_FILE}): ${error}`);
  }
}

export function skipIfContractInState(state: DeploymentState, key: Sk) {
  return SKIP_IF_CONTRACT_IN_STATE && state[key] && (state[key].address || state[key].proxy.address);
}

export const newCombinedAragonVoting = async (
  holder: HardhatEthersSigner,
  voteDescription: string,
): Promise<bigint> => {
  const { tm, voting, voteScript } = await loadCtx();
  let voteItems: VoteItem[] = [];
  // dg, et, any
  const mode = process.env.VOTE_MODE || "";

  log("Creating new vote with description:", voteDescription);
  if (mode !== "dg") {
    const items = (await voteScript.getVotingVoteItems()) as VoteItem[];
    voteItems = voteItems.concat(items);
  }

  if (mode !== "et") {
    const items = (await voteScript.getVoteItemsPacked()) as VoteItem[];
    voteItems = voteItems.concat(items);
  }
  log("items:");
  log(voteItems.map(({ description }) => description));
  const evmScript = encodeCallScript(voteItems.map(({ call }) => ({ to: call.to, data: call.data })));
  const evmScriptNewVote = encodeCallScript([
    {
      to: voting.address,
      data: voting.interface.encodeFunctionData("newVote(bytes,string,bool,bool)", [
        evmScript,
        voteDescription,
        true,
        true,
      ]),
    },
  ]);

  // console.log("estimateGas newVote", await tm.connect(holder).forward.estimateGas(evmScriptNewVote));
  log("Forwarding evmScript via TokenManager to create a new vote...");
  const tx = await tm.connect(holder).forward(evmScriptNewVote);
  const receipt = await _tx(tx);
  const voteId = await findEventsWithInterfaces(receipt, "StartVote", [voting.interface])[0].args.voteId;
  log.success("New vote created. voteId:", voteId);
  return voteId;
};

export const mockAragonVoting = async (holder: HardhatEthersSigner, voteId: bigint, voteDescription: string) => {
  if (!voteId) {
    voteId = await newCombinedAragonVoting(holder, voteDescription);
  } else {
    log("Using existing voteId:", voteId);
  }
  const { voting } = await loadCtx();

  const vote = await voting.getVote(voteId);
  if (!vote.startDate) {
    log.error("Vote with id", voteId, "does not exist");
    return;
  } else if (vote.executed) {
    log.warning("Vote is already executed, nothing to do");
    return;
  }

  if ((await voting.canVote(voteId, holder)) && (await voting.getVoterState(voteId, holder)) !== 1n) {
    log("Try to cast...");
    const voteTx = await voting.connect(holder).vote(voteId, true, true);
    await _tx(voteTx);
    log.success("Cast “Yes” on voteId:", voteId);
  } else {
    log.warning("Can't cast voteId:", voteId);
  }

  if (getMode() === "forking") {
    const voteTime = await voting.voteTime();
    const endTime = vote.startDate + voteTime;
    const currentTime = await getCurrentBlockTimestamp();
    console.log({
      currentTime,
      voteTime,
      endTime,
    });
    if (currentTime < endTime) {
      const timeToAdvance = endTime - currentTime + 60n;
      log.warning(`Advancing chain time by ${timeToAdvance} seconds to reach vote start time...`);
      await advanceChainTime(timeToAdvance);
    }
  }

  if (await voting.canExecute(voteId)) {
    log("Try to execute...");
    const execTx = await voting.connect(holder).executeVote(voteId);
    const receipt = await _tx(execTx);
    log.success("executed voteId:", voteId);

    const { template, lido, stakingRouter } = await loadCtx();
    const { eventsByContract, skipped } = parseLEventsWithContracts(receipt.logs, [
      template,
      lido,
      stakingRouter,
      voting,
    ]);
    if (skipped.length > 0) {
      log.warning("not parsed logs:", skipped.length);
    }

    console.log("Events:");
    logContractEvents("UpgradeTemplate", eventsByContract[template.address]);
    // logContractEvents("Lido", eventsByContract[lido.address]);
    // logContractEvents("StakingRouter", eventsByContract[stakingRouter.address]);
    // logContractEvents("Voting", eventsByContract[voting.address]);
  } else {
    log.warning("VoteId", voteId, "is not ready for execution");
  }
};

export async function mockDGAragonVoting(state: DeploymentState): Promise<{
  proposalId: bigint;
  scheduleReceipt: TransactionReceipt | null;
  executeReceipt: TransactionReceipt | null;
}> {
  log("Starting mock Aragon voting...");

  // https://dg.lido.fi/proposals/{proposalId}
  let proposalId = BigInt(PROPOSAL_ID ?? "0");

  const agent = await impersonate(getAddress(Sk.appAgent, state), ether("100"));

  const { template, dg, voteScript: vs, timelock } = await loadCtx();

  const proposers = await dg.getProposers();
  if (!proposers.length) {
    throw new Error("No proposer found in DualGovernance.");
  }
  const proposer = await impersonate(proposers[0].account, ether("100"));

  log.info("Contracts prepared for DG execution", {
    voteScript: vs.address,
    template: template.address,
    dualGovernance: dg.address,
    timelock: timelock.address,
    proposer: proposer.address,
  });

  if (proposalId) {
    log.warning("Using provided proposal ID:", proposalId);
  } else {
    // const evmScript =   await script.getEVMScript(proposalMetadata);
    // console.log(evmScript);
    const dgItems = await vs.getVoteItems();
    const proposalMetadata = PROPOSAL_METADATA;
    const proposalCalls = dgItems.map(({ call: { to, data } }) => ({ target: to, value: 0n, payload: data }));
    log.info("Collect DG proposal", {
      callsCount: proposalCalls.length,
      metadata: proposalMetadata,
    });

    proposalId = (await dg
      .connect(proposer)
      .getFunction("submitProposal")
      .staticCall(proposalCalls, proposalMetadata)) as bigint;

    const submitTx = await dg.connect(proposer).submitProposal(proposalCalls, proposalMetadata);
    await log.txLink(submitTx.hash);
    const submitReceipt = (await submitTx.wait())!;
    log.success("Proposal submitted ID:", proposalId);
    log.success("Proposal submit gas used", submitReceipt.gasUsed);
  }

  const afterSubmitDelay = await timelock.getAfterSubmitDelay();
  const afterScheduleDelay = await timelock.getAfterScheduleDelay();

  let scheduleReceipt: TransactionReceipt | null = null;
  let executeReceipt: TransactionReceipt | null = null;

  let { status } = await timelock.getProposalDetails(proposalId);

  if (status < 1n || status > 2n) {
    throw new Error("Proposal not submitted or already executed");
  }

  if (status == 1n) {
    log.info("Proposal submitted, try for schedule...");
    let canSchedule = await timelock.canSchedule(proposalId);
    if (!canSchedule) {
      await advanceChainTime(afterSubmitDelay);
      canSchedule = await timelock.canSchedule(proposalId);
      log.info("time pass: canSchedule", { canSchedule });
      if (!canSchedule) {
        throw new Error("Proposal can't be scheduled");
      }
    }

    const scheduleTx = await dg.connect(agent).scheduleProposal(proposalId);
    scheduleReceipt = (await scheduleTx.wait())!;
    log.success("Proposal scheduled: gas used", scheduleReceipt.gasUsed);
    ({ status } = await timelock.getProposalDetails(proposalId));
  }

  if (status == 2n) {
    log.info("Proposal scheduled, try for execute...");
    let canExecute = await timelock.canExecute(proposalId);
    if (!canExecute) {
      await advanceChainTime(afterScheduleDelay);
      canExecute = await timelock.canExecute(proposalId);
      log.info("time pass: canExecute", { canExecute });
      if (!canExecute) {
        throw new Error("Proposal can't be executed");
      }
    }

    let executeTx: TransactionResponse;
    let revertedDueToTimeConstraints: boolean = true;
    let attempts: number = 0;
    let lastError: unknown;

    while (revertedDueToTimeConstraints && attempts < 24) {
      try {
        log.info("exec try", { attempts });
        executeTx = await timelock.connect(agent).execute(proposalId);
        revertedDueToTimeConstraints = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        const data = e?.data ?? e?.error?.data ?? e?.revert?.data;
        if (data) {
          try {
            const { name, args } = template.interface.parseError(data)!;
            log.error("Error name:", name);
            log.error("Error args:", args);
          } catch {
            log.error("Can't parse error:", data);
          }
        }

        await advanceChainTime(ONE_HOUR);
        attempts++;
        lastError = e;
      }
    }
    if (revertedDueToTimeConstraints) {
      log.error("Failed to execute proposal", proposalId);
      throw lastError;
    }

    executeReceipt = (await executeTx!.wait())!;
    log.success("Proposal executed: gas used", executeReceipt.gasUsed);

    if (executeReceipt.gasUsed > FUSAKA_TX_GAS_LIMIT) {
      throw new Error("Gas used exceeds FUSAKA_TX_GAS_LIMIT");
    }
  }

  return { proposalId, scheduleReceipt, executeReceipt };
}

/// ----  helpers ----

type Ctx = {
  tm: LoadedContract<TokenManager>;
  dg: LoadedContract<IDualGovernance>;
  voting: LoadedContract<Voting>;
  template: LoadedContract<UpgradeTemplate>;
  voteScript: LoadedContract<UpgradeVoteScript>;
  timelock: LoadedContract<ITimelock>;
  lido: LoadedContract<Lido>;
  stakingRouter: LoadedContract<StakingRouter>;
};

let ctxPromise: Promise<Ctx> | undefined;

export const loadCtx = (): Promise<Ctx> => {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      try {
        const state = readNetworkState();
        const [tm, dg, voting, template, voteScript, timelock, lido, stakingRouter] = await Promise.all([
          loadContract<TokenManager>("TokenManager", getAddress(Sk.appTokenManager, state)),
          loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state)),
          loadContract<Voting>("Voting", getAddress(Sk.appVoting, state)),
          loadContract<UpgradeTemplate>("UpgradeTemplate", getAddress(Sk.upgradeTemplate, state)),
          loadContract<UpgradeVoteScript>("UpgradeVoteScript", getAddress(Sk.upgradeVoteScript, state)),
          loadContract<ITimelock>("ITimelock", getAddress(Sk.dgEmergencyProtectedTimelock, state)),
          loadContract<Lido>("Lido", getAddress(Sk.appLido, state)),
          loadContract<StakingRouter>("StakingRouter", getAddress(Sk.stakingRouter, state)),
        ]);

        return {
          tm,
          dg,
          voting,
          template,
          voteScript,
          timelock,
          lido,
          stakingRouter,
        };
      } catch (error) {
        ctxPromise = undefined;
        throw error;
      }
    })();
  }

  return ctxPromise;
};

export const _tx = async (tx: ContractTransactionResponse): Promise<ContractTransactionReceipt> => {
  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error(`Transaction ${tx.hash} did not return a receipt`);
  }

  const logData = Object.fromEntries(
    Object.entries({
      GasUsed: receipt.gasUsed,
      Link: await getTxLink(tx.hash),
    }).filter(([, v]) => v !== null),
  ) as Record<string, ConvertibleToString>;

  log.info("Transaction", logData);
  return receipt;
};

function logContractEvents(c: string, ce: ContractEvents) {
  log(`${c} - parsed: ${ce.parsed.length} events, unparsed: ${ce.unparsed.length} events`);
  for (const evt of ce.parsed) {
    console.log(evt);
  }
}
export type EventArgs = Record<string, unknown>;
export type ContractEvents = {
  parsed: EventArgs[];
  unparsed: Log[];
};
export type ContractEvents1 = Record<string, ContractEvents>;

export function toEventArgs(l: LogDescription): EventArgs {
  const args = Object.fromEntries(l.fragment.inputs.map((a, i) => [a.name || String(i), l.args[i]]));

  return {
    [l.signature]: args,
  };
}

export function parseLEventsWithContracts(
  logs: readonly Log[],
  contracts: readonly LoadedContract[],
): {
  eventsByContract: Record<string, ContractEvents>;
  skipped: Log[];
} {
  const eventsByContract: Record<string, ContractEvents> = {};
  const contractsByAddress = new Map<string, LoadedContract>();
  const skipped: Log[] = [];

  for (const contract of contracts) {
    eventsByContract[contract.address] = { parsed: [], unparsed: [] };
    contractsByAddress.set(contract.address.toLowerCase(), contract);
  }

  for (const entry of logs) {
    const contract = contractsByAddress.get(entry.address.toLowerCase());
    if (!contract) {
      skipped.push(entry);
      continue;
    }

    try {
      const parsedEvent = contract.interface.parseLog(entry);
      if (parsedEvent) {
        eventsByContract[contract.address].parsed.push(toEventArgs(parsedEvent));
      } else {
        eventsByContract[contract.address].unparsed.push(entry);
      }
    } catch {
      eventsByContract[contract.address].unparsed.push(entry);
    }
  }

  return { eventsByContract, skipped };
}
