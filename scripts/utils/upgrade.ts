import { id, TransactionReceipt } from "ethers";
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

// Only these TimeConstraints reverts are cleared by advancing the chain clock:
// `DayTimeOutOfRange` (outside the daily execution window) and `TimestampNotPassed`
// (a not-before timestamp still in the future). `DayTimeOverflow` and
// `TimestampPassed` are permanent — retrying them just burns 24 simulated hours
// before failing, so we let any non-retryable revert propagate immediately.
// Underlying ABI types: Duration is uint32, Timestamp is uint40 (DG submodule).
const DG_RETRYABLE_TIME_CONSTRAINT_NAMES = ["DayTimeOutOfRange", "TimestampNotPassed"] as const;
const DG_RETRYABLE_TIME_CONSTRAINT_SELECTORS = new Set([
  id("DayTimeOutOfRange(uint32,uint32,uint32)").slice(0, 10),
  id("TimestampNotPassed(uint40)").slice(0, 10),
]);

// The TimeConstraints check lives inside the proposal's external call, not in the
// timelock ABI, so ethers usually can't decode it — we match the raw 4-byte
// selector on any revert-data field, and fall back to the decoded error name
// when ethers (or a wrapped provider) did surface it as text.
function isRetryableTimeConstraint(e: unknown): boolean {
  const err = e as { data?: unknown; info?: { error?: { data?: unknown } }; error?: { data?: unknown } };
  const dataFields = [err?.data, err?.info?.error?.data, err?.error?.data];
  for (const d of dataFields) {
    if (typeof d === "string" && DG_RETRYABLE_TIME_CONSTRAINT_SELECTORS.has(d.slice(0, 10))) {
      return true;
    }
  }
  const text = `${(e as { message?: string })?.message ?? ""} ${String(e)}`;
  return DG_RETRYABLE_TIME_CONSTRAINT_NAMES.some((name) => text.includes(name));
}

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
      // Fail fast on anything that isn't a transient time-window revert: an
      // unrelated failure should surface now, not after 24 retry hours.
      if (!retry || attempts >= DG_TIME_CONSTRAINT_RETRY_MAX_ATTEMPTS || !isRetryableTimeConstraint(e)) throw e;
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
