import { TransactionReceipt, TransactionResponse } from "ethers";
import fs from "fs";

import * as toml from "@iarna/toml";

import { IDualGovernance, ITimelock, UpgradeTemplate, UpgradeVoteScript } from "typechain-types";

import { advanceChainTime, ether, impersonate, log } from "lib";
import { UpgradeParameters, validateUpgradeParameters } from "lib/config-schemas";
import { loadContract } from "lib/contract";
import { DeploymentState, getAddress, Sk } from "lib/state-file";

import { FUSAKA_TX_GAS_LIMIT, ONE_HOUR } from "test/suite";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;
const PROPOSAL_ID = process.env.PROPOSAL_ID || "";
const PROPOSAL_METADATA = process.env.PROPOSAL_METADATA || "proposal-metadata";

export { UpgradeParameters };

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

export async function mockDGAragonVoting(state: DeploymentState): Promise<{
  proposalId: bigint;
  scheduleReceipt: TransactionReceipt | null;
  executeReceipt: TransactionReceipt | null;
}> {
  log("Starting mock Aragon voting...");

  // https://dg.lido.fi/proposals/{proposalId}
  let proposalId = BigInt(PROPOSAL_ID ?? "0");

  const agent = await impersonate(getAddress(Sk.appAgent, state), ether("100"));

  const vs = await loadContract<UpgradeVoteScript>("UpgradeVoteScript", getAddress(Sk.upgradeVoteScript, state));
  const template = await loadContract<UpgradeTemplate>("UpgradeTemplate", getAddress(Sk.upgradeTemplate, state));
  const dg = await loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state));
  const timelock = await loadContract<ITimelock>("ITimelock", getAddress(Sk.dgEmergencyProtectedTimelock, state));

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
