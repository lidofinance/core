import { BigNumberish, ContractTransactionReceipt, ContractTransactionResponse } from "ethers";
import fs from "fs";
import { getMode } from "hardhat.helpers";

import * as toml from "@iarna/toml";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { IDualGovernance, ITimelock, TokenManager, UpgradeTemplate, UpgradeVoteScript, Voting } from "typechain-types";

import {
  advanceChainTime,
  bl,
  ConvertibleToString,
  ether,
  findEventsWithInterfaces,
  getCurrentBlockTimestamp,
  getSignerOrImpersonate,
  impersonate,
  isContractDeployed,
  loadContract,
  LoadedContract,
  log,
  or,
  yl,
} from "lib";
import { UpgradeParameters, validateUpgradeParameters } from "lib/config-schemas";
import { getTxLink } from "lib/explorer";
import {
  DeploymentState,
  getAddress,
  getAddressValidated,
  readNetworkState,
  Sk,
  updateObjectInState,
} from "lib/state-file";

import { FUSAKA_TX_GAS_LIMIT, ONE_HOUR } from "test/suite";

import { encodeCallScript, VoteItem } from "./omnibus";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;
const PROPOSAL_ID = BigInt(process.env.PROPOSAL_ID || "0");
const PROPOSAL_METADATA = process.env.PROPOSAL_METADATA || "proposal-metadata";
const VOTE_ID = BigInt(process.env.VOTE_ID || "0");
const VOTE_DESCRIPTION = process.env.VOTE_DESCRIPTION || "vote-description";
const VOTE_MODE = process.env.VOTE_MODE || "dg"; // DG mode by default

export { UpgradeParameters };

///
/// ---- Upgrade helpers ----
///
export function readUpgradeParameters(skipValidation: boolean = false): UpgradeParameters {
  const filePath = getUpgradeParametersFilePath();
  const rawData = fs.readFileSync(filePath, "utf8");
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

function getUpgradeParametersFilePath(): string {
  if (!UPGRADE_PARAMETERS_FILE) {
    throw new Error("UPGRADE_PARAMETERS_FILE is not set");
  }

  if (!fs.existsSync(UPGRADE_PARAMETERS_FILE)) {
    throw new Error(`Upgrade parameters file not found: ${UPGRADE_PARAMETERS_FILE}`);
  }

  return UPGRADE_PARAMETERS_FILE;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getLineEnding(content: string): string {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * Updates a single key in TOML section while preserving the rest of the file as-is.
 * If the key doesn't exist in the section, appends it at the end of the section.
 */
export function writeUpgradeEasyTrackFactoryAddress(sectionName: string, paramKey: string, address: string): void {
  const filePath = getUpgradeParametersFilePath();
  const content = fs.readFileSync(filePath, "utf8");

  const sectionHeaderRegex = new RegExp(`^\\s*\\[${escapeRegExp(sectionName)}\\]\\s*$`, "m");
  const sectionHeaderMatch = sectionHeaderRegex.exec(content);
  if (!sectionHeaderMatch) {
    throw new Error(`Section [${sectionName}] not found in ${filePath}`);
  }

  const sectionStart = sectionHeaderMatch.index + sectionHeaderMatch[0].length;
  const contentAfterSectionHeader = content.slice(sectionStart);
  const nextSectionMatch = /^\s*\[[^\]]+\]\s*$/m.exec(contentAfterSectionHeader);
  const sectionEnd = nextSectionMatch ? sectionStart + nextSectionMatch.index : content.length;

  const beforeSection = content.slice(0, sectionStart);
  const sectionContent = content.slice(sectionStart, sectionEnd);
  const afterSection = content.slice(sectionEnd);

  const keyLineRegex = new RegExp(`^(\\s*${escapeRegExp(paramKey)}\\s*=\\s*")([^"]*)(".*)$`, "m");
  let updatedSectionContent: string;

  if (keyLineRegex.test(sectionContent)) {
    updatedSectionContent = sectionContent.replace(keyLineRegex, `$1${address}$3`);
  } else {
    const lineEnding = getLineEnding(content);
    const separator = sectionContent.endsWith("\n") || sectionContent.endsWith("\r\n") ? "" : lineEnding;
    updatedSectionContent = `${sectionContent}${separator}${paramKey} = "${address}"${lineEnding}`;
  }

  const updatedContent = `${beforeSection}${updatedSectionContent}${afterSection}`;
  if (updatedContent !== content) {
    fs.writeFileSync(filePath, updatedContent, "utf8");
  }
}

export const mockAragonVoting = async (state: DeploymentState) => {
  const holderAddress = process.env.HOLDER || process.env.DEPLOYER || "";
  const holder = await getSignerOrImpersonate(holderAddress, ether("100"));
  log("Starting mock Aragon voting...");

  let voteId: BigNumberish | undefined = VOTE_ID || undefined;

  if (!voteId) {
    // try to get voteId from state
    voteId = state[Sk.upgradeVoteScript].voteState?.voteId;
  } else {
    log.warning("Using provided voteId:", voteId);
  }
  if (!voteId) {
    // create new vote
    const voteDescription = VOTE_DESCRIPTION;
    voteId = await newAragonVoting(state, holder, voteDescription);

    // save voteId in deployed state
    updateObjectInState(Sk.upgradeVoteScript, {
      voteState: {
        voteId: voteId.toString(),
        voteDescription,
      },
    });
  } else {
    log.warning("Using saved in state voteId:", voteId);
  }

  let receipt = await mockEnactAragonVoting(state, voteId, holder);

  if (VOTE_MODE === "dg") {
    const { dg } = await upgCtx(state);
    const proposalId = findEventsWithInterfaces(receipt, "ProposalSubmitted", [dg.interface])[0].args.proposalId;
    log.success("submitted proposalId:", proposalId);
    const agent = await impersonate(getAddress(Sk.appAgent, state), ether("100"));
    receipt = await mockEnactDGProposal(state, proposalId, agent);
  }
  const { template } = await upgCtx(state);
  const event = findEventsWithInterfaces(receipt, "UpgradeFinished", [template.interface])[0];
  if (event) {
    log.success("Template UpgradeFinished event found in tx:", receipt.hash);
  }
};

async function newAragonVoting(
  state: DeploymentState,
  holder: HardhatEthersSigner,
  voteDescription: string,
): Promise<bigint> {
  const { tm, voting, voteScript } = await upgCtx(state);
  let voteItems: VoteItem[] = [];
  let evmScriptNewVote;
  if (VOTE_MODE === "dg") {
    evmScriptNewVote = await voteScript.getNewVoteCallBytecode(VOTE_DESCRIPTION, PROPOSAL_METADATA);
  } else {
    log("Creating new vote (no DG):", voteDescription);
    if (VOTE_MODE !== "skipVotingItems") {
      const items = (await voteScript.getVotingVoteItems()) as VoteItem[];
      voteItems = voteItems.concat(items);
    }

    if (VOTE_MODE !== "skipDGItems") {
      const items = (await voteScript.getVoteItems()) as VoteItem[];
      voteItems = voteItems.concat(items);
    }
    log("items:");
    log(voteItems.map(({ description }) => description));
    const evmScript = encodeCallScript(voteItems.map(({ call }) => ({ to: call.to, data: call.data })));
    evmScriptNewVote = encodeCallScript([
      {
        to: voting.address,
        data: voting.interface.encodeFunctionData("newVote(bytes,string,bool,bool)", [
          evmScript,
          voteDescription,
          false,
          false,
        ]),
      },
    ]);
  }

  log("Forwarding evmScript via TokenManager to create a new vote...");
  const tx = await tm.connect(holder).forward(evmScriptNewVote);
  const receipt = await txWaitAndLog(tx);
  const voteId = findEventsWithInterfaces(receipt, "StartVote", [voting.interface])[0].args.voteId;
  log.success("New vote created. voteId:", voteId);
  return voteId;
}

async function mockEnactAragonVoting(state: DeploymentState, voteId: BigNumberish, holder: HardhatEthersSigner) {
  const { voting } = await upgCtx(state);

  const vote = await voting.getVote(voteId);

  if (!vote.startDate || vote.executed) {
    throw new Error(`VoteId ${voteId} does not exist or already executed`);
  }

  if ((await voting.canVote(voteId, holder)) && (await voting.getVoterState(voteId, holder)) !== 1n) {
    log("Try to cast...");
    const voteTx = await voting.connect(holder).vote(voteId, true, true);
    await txWaitAndLog(voteTx);
    log.success("Cast “Yes” on voteId:", voteId);
  } else {
    log.warning("Can't cast voteId:", voteId);
  }

  if (getMode() === "forking") {
    const voteTime = await voting.voteTime();
    const endTime = vote.startDate + voteTime;
    const currentTime = await getCurrentBlockTimestamp();
    if (currentTime < endTime) {
      const timeToAdvance = endTime - currentTime + 60n;
      log.warning(`Advancing chain time by ${timeToAdvance} seconds to reach vote start time...`);
      await advanceChainTime(timeToAdvance);
    }
  }

  if (await voting.canExecute(voteId)) {
    log("Try to execute...");
    const execTx = await voting.connect(holder).executeVote(voteId);
    const receipt = await txWaitAndLog(execTx);
    log.success("executed voteId:", voteId);

    if (receipt.gasUsed > FUSAKA_TX_GAS_LIMIT) {
      throw new Error("Gas used exceeds FUSAKA_TX_GAS_LIMIT");
    }

    return receipt;
  } else {
    throw new Error(`VoteId ${voteId} is not ready for execution`);
  }
}

async function mockEnactDGProposal(state: DeploymentState, proposalId: bigint, executor: HardhatEthersSigner) {
  const { dg, timelock } = await upgCtx(state);

  const afterSubmitDelay = await timelock.getAfterSubmitDelay();
  const afterScheduleDelay = await timelock.getAfterScheduleDelay();

  let { status } = await timelock.getProposalDetails(proposalId);

  if (status < 1n || status > 2n) {
    throw new Error("Proposal not submitted or already executed");
  }

  if (status == 1n) {
    log("Proposal submitted, try for schedule...");
    let canSchedule = await timelock.canSchedule(proposalId);
    if (!canSchedule) {
      await advanceChainTime(afterSubmitDelay);
      canSchedule = await timelock.canSchedule(proposalId);
      if (!canSchedule) {
        throw new Error("Proposal can't be scheduled");
      }
    }

    const scheduleTx = await dg.connect(executor).scheduleProposal(proposalId);
    const scheduleReceipt = (await scheduleTx.wait())!;
    log.success("Proposal scheduled: gas used", scheduleReceipt.gasUsed);
    ({ status } = await timelock.getProposalDetails(proposalId));
  }

  if (status == 2n) {
    log("Proposal scheduled, try for execute...");
    let canExecute = await timelock.canExecute(proposalId);
    if (!canExecute) {
      await advanceChainTime(afterScheduleDelay);
      canExecute = await timelock.canExecute(proposalId);
      if (!canExecute) {
        throw new Error("Proposal can't be executed");
      }
    }

    let execTx: ContractTransactionResponse;
    let revertedDueToTimeConstraints: boolean = true;
    let attempts: number = 0;
    let lastError: unknown;

    while (revertedDueToTimeConstraints && attempts < 24) {
      try {
        execTx = await timelock.connect(executor).execute(proposalId);
        revertedDueToTimeConstraints = false;
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        // const data = e?.data ?? e?.error?.data ?? e?.revert?.data;
        // if (data) {
        //   try {
        //     const { name, args } = template.interface.parseError(data)!;
        //     log.error("Error name:", name);
        //     log.error("Error args:", args);
        //   } catch {
        //     log.error("Can't parse error:", data);
        //   }
        // }

        await advanceChainTime(ONE_HOUR);
        attempts++;
        lastError = e;
      }
    }
    if (revertedDueToTimeConstraints) {
      log.error("Failed to execute proposal", proposalId);
      throw lastError;
    }
    // const execTx = await timelock.connect(executor).execute(proposalId);
    const receipt = await txWaitAndLog(execTx!);
    log.success("executed proposalId:", proposalId);

    if (receipt.gasUsed > FUSAKA_TX_GAS_LIMIT) {
      throw new Error("Gas used exceeds FUSAKA_TX_GAS_LIMIT");
    }
    return receipt;
  }

  throw new Error("Proposal not scheduled");
}

export async function mockDGAragonVoting(state: DeploymentState) {
  log("Starting mock DG Aragon voting...");

  let proposalId = PROPOSAL_ID;

  const agent = await impersonate(getAddress(Sk.appAgent, state), ether("100"));

  const { dg, voteScript } = await upgCtx(state);

  const proposers = await dg.getProposers();
  if (!proposers.length) {
    throw new Error("No proposer found in DualGovernance.");
  }
  const proposer = await impersonate(proposers[0].account, ether("100"));

  if (proposalId) {
    log.warning("Using provided proposal ID:", proposalId);
  } else {
    // const evmScript =   await script.getEVMScript(proposalMetadata);
    // console.log(evmScript);
    const dgItems = await voteScript.getVoteItems();
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

  const receipt = await mockEnactDGProposal(state, proposalId, agent);
  const { template } = await upgCtx(state);
  const event = findEventsWithInterfaces(receipt, "UpgradeFinished", [template.interface])[0];
  if (!event) {
    throw new Error("UpgradeFinished event not found");
  }
}

/// ----  helpers ----

type Ctx = {
  tm: LoadedContract<TokenManager>;
  dg: LoadedContract<IDualGovernance>;
  voting: LoadedContract<Voting>;
  template: LoadedContract<UpgradeTemplate>;
  voteScript: LoadedContract<UpgradeVoteScript>;
  timelock: LoadedContract<ITimelock>;
};

let ctxPromise: Promise<Ctx> | undefined;

export const upgCtx = (state: DeploymentState): Promise<Ctx> => {
  if (!ctxPromise) {
    ctxPromise = (async () => {
      try {
        const [tm, dg, voting, template, voteScript, timelock] = await Promise.all([
          loadContract<TokenManager>("TokenManager", getAddress(Sk.appTokenManager, state)),
          loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state)),
          loadContract<Voting>("Voting", getAddress(Sk.appVoting, state)),
          loadContract<UpgradeTemplate>("UpgradeTemplate", getAddress(Sk.upgradeTemplate, state)),
          loadContract<UpgradeVoteScript>("UpgradeVoteScript", getAddress(Sk.upgradeVoteScript, state)),
          loadContract<ITimelock>("ITimelock", getAddress(Sk.dgEmergencyProtectedTimelock, state)),
        ]);

        return {
          tm,
          dg,
          voting,
          template,
          voteScript,
          timelock,
        };
      } catch (error) {
        ctxPromise = undefined;
        throw error;
      }
    })();
  }

  return ctxPromise;
};

export async function txWaitAndLog(tx: ContractTransactionResponse): Promise<ContractTransactionReceipt> {
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
}

export async function checkArtifactDeployedAndLog(artifactName: Sk): Promise<boolean> {
  const state = readNetworkState();
  // check if contract object exists in deployed state but address set as empty string or zero address
  const address = getAddressValidated(artifactName, state);
  // check if contract not deployed yet
  const isDeployed = !!(address && (await isContractDeployed(address)));
  if (isDeployed) {
    log.splitter();
    log(yl(`Artifact <${or(Sk.upgradeTemplate)}> exists and deployed at [${bl(address)}], skipping step...`));
  }
  return isDeployed;
}
