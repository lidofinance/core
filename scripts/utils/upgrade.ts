import { TransactionReceipt } from "ethers";
import fs from "fs";

import * as toml from "@iarna/toml";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

import { IDualGovernance, IEmergencyProtectedTimelock } from "typechain-types";

import { advanceChainTime, ether, log } from "lib";
import { impersonate } from "lib/account";
import { UpgradeParameters, validateUpgradeParameters } from "lib/config-schemas";
import { loadContract } from "lib/contract";
import { DeploymentState, getAddress, Sk } from "lib/state-file";

import { ONE_HOUR } from "test/suite";

const UPGRADE_PARAMETERS_FILE = process.env.UPGRADE_PARAMETERS_FILE;

// Fusaka activates a per-tx 16M gas cap (EIP-7825). DG proposals that
// exceed it execute fine on a pre-Fusaka fork but would revert at mainnet.
const FUSAKA_TX_LIMIT = 2n ** 24n; // 16_777_216

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

const DG_TIME_CONSTRAINT_RETRY_STEP = ONE_HOUR;
const DG_TIME_CONSTRAINT_RETRY_MAX_ATTEMPTS = 24;

export interface ExecuteDGProposalOpts {
  dualGovernance: IDualGovernance;
  timelock: IEmergencyProtectedTimelock;
  signer: HardhatEthersSigner;
  proposalId: bigint;
  retryOnTimeConstraint?: boolean;
}

/**
 * Schedule + execute an already-submitted DG proposal. Advances chain time across
 * the after-submit and after-schedule delays. With `retryOnTimeConstraint`, the
 * execute call is retried when it reverts due to a TimeConstraints window —
 * mainnet's launch omnibus uses these (executable only between 06:00 and 18:00
 * UTC). Scratch has no time constraints, so callers there leave it off.
 */
export async function executeDGProposal(
  opts: ExecuteDGProposalOpts,
): Promise<{ scheduleReceipt: TransactionReceipt; executeReceipt: TransactionReceipt }> {
  const { dualGovernance, timelock, signer, proposalId } = opts;
  const retry = opts.retryOnTimeConstraint ?? false;

  await advanceChainTime(await timelock.getAfterSubmitDelay());
  const scheduleReceipt = (await (await dualGovernance.connect(signer).scheduleProposal(proposalId)).wait())!;
  log.success("Proposal scheduled: gas used", scheduleReceipt.gasUsed);

  await advanceChainTime(await timelock.getAfterScheduleDelay());

  let executeReceipt: TransactionReceipt | undefined;
  let attempts = 0;
  while (!executeReceipt) {
    try {
      executeReceipt = (await (await timelock.connect(signer).execute(proposalId)).wait())!;
    } catch (e) {
      if (!retry || attempts >= DG_TIME_CONSTRAINT_RETRY_MAX_ATTEMPTS) throw e;
      await advanceChainTime(DG_TIME_CONSTRAINT_RETRY_STEP);
      attempts++;
    }
  }
  log.success("Proposal executed: gas used", executeReceipt.gasUsed);
  return { scheduleReceipt, executeReceipt };
}

export interface ExecuteExistingDGProposalOnForkOpts {
  state: DeploymentState;
  proposalId: bigint;
  // Account that calls `scheduleProposal` and `execute`. Both are
  // permission-less after their respective delays, so any funded EOA
  // works; defaults to Agent for parity with the historical helper.
  callerAddress?: string;
  // Abort with exit(1) when the executed tx exceeds Fusaka's per-tx gas
  // cap — catches an over-fat omnibus in dry-run instead of at mainnet.
  // Defaults to true.
  enforceFusakaTxLimit?: boolean;
}

/**
 * Schedule + execute an already-submitted DG proposal on a local fork:
 * load DG/timelock from the network state, impersonate a caller, advance
 * across the submit/schedule delays via `executeDGProposal`, and (by
 * default) abort if the execute tx breaches Fusaka's 16M gas cap.
 *
 * Historically called `mockDGAragonVoting` — the post-DG analog of the
 * pre-DG "mock Aragon voting" fast-forward step.
 */
export async function executeExistingDGProposalOnFork(opts: ExecuteExistingDGProposalOnForkOpts): Promise<{
  proposalId: bigint;
  scheduleReceipt: TransactionReceipt;
  proposalExecutedReceipt: TransactionReceipt;
}> {
  const { state, proposalId } = opts;
  const callerAddress = opts.callerAddress ?? getAddress(Sk.appAgent, state);
  const enforceFusakaTxLimit = opts.enforceFusakaTxLimit ?? true;

  log(`Executing existing DG proposal #${proposalId} as ${callerAddress}`);
  const signer = await impersonate(callerAddress, ether("100"));
  const timelock = await loadContract<IEmergencyProtectedTimelock>(
    "IEmergencyProtectedTimelock",
    getAddress(Sk.dgEmergencyProtectedTimelock, state),
  );
  const dualGovernance = await loadContract<IDualGovernance>("IDualGovernance", getAddress(Sk.dgDualGovernance, state));

  const { scheduleReceipt, executeReceipt } = await executeDGProposal({
    dualGovernance,
    timelock,
    signer,
    proposalId,
    retryOnTimeConstraint: true,
  });

  if (enforceFusakaTxLimit && executeReceipt.gasUsed > FUSAKA_TX_LIMIT) {
    log.error(`Proposal #${proposalId} execute gas (${executeReceipt.gasUsed}) exceeds FUSAKA_TX_LIMIT`);
    process.exit(1);
  }

  return { proposalId, scheduleReceipt, proposalExecutedReceipt: executeReceipt };
}
