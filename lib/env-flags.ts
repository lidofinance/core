// Leaf module (no lib/scratch imports) so deploy scripts can use these flags
// without creating a dependency cycle with the step runner.

const TRUTHY_VALUES = new Set(["1", "true", "yes", "on"]);
const FALSY_VALUES = new Set(["false", "0", "off", "no"]);

export function isTruthyEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return v !== undefined && TRUTHY_VALUES.has(v);
}

// `RESUME` is opt-in: a truthy value makes the scratch deploy reuse the existing
// state file and skip steps recorded under Sk.scratchDeployCompletedSteps,
// instead of wiping the state and starting from 0000.
export function isResumeEnabled(): boolean {
  return isTruthyEnv("RESUME");
}

// Opt-out flag: default ON, disabled via any of the common falsy strings
// ("false", "0", "off", "no" — case-insensitive). The strict `=== "false"` check
// used previously rejected the rest, which surprised users typing `...=0`.
export function isOptOutEnv(name: string): boolean {
  const v = process.env[name]?.trim().toLowerCase();
  return !v || !FALSY_VALUES.has(v);
}

// `DG_DEPLOYMENT_ENABLED` is opt-out (default ON): when falsy, the scratch deploy
// skips Dual Governance (step 0160 finalizes permissions without it).
export function isDGDeploymentEnabled(): boolean {
  return isOptOutEnv("DG_DEPLOYMENT_ENABLED");
}

// `CSM_DEPLOYMENT_ENABLED` / `CMV2_DEPLOYMENT_ENABLED` are opt-out (default ON): when
// falsy, step 0135 skips that module's deploy from the external
// lidofinance/community-staking-module repo, and step 0140 leaves it unplugged (it keys
// off the module's state entry). The two are independent in that repo — separate `just`
// recipes, forge scripts and deploy artifacts, and CMv2 deploys its own Ejector,
// HashConsensus, Accounting and FeeOracle rather than reusing CSM's. What does couple
// them is on this side: StakingRouter assigns module ids in plug order (NOR 1,
// SimpleDVT 2, then whichever of CSM / CMv2 is deployed) and ConsolidationMigrator takes
// `[consolidationMigrator].targetModuleId` as an immutable ctor arg in step 0083, so
// turning CSM off while CMv2 stays on shifts CMv2's id. The scratch preflight checks
// that pairing before the expensive external deploy runs.
export function isCSMDeploymentEnabled(): boolean {
  return isOptOutEnv("CSM_DEPLOYMENT_ENABLED");
}

export function isCMv2DeploymentEnabled(): boolean {
  return isOptOutEnv("CMV2_DEPLOYMENT_ENABLED");
}

// `PROTOCOL_ACTIVATION_ENABLED` is opt-in (default OFF): when truthy, the scratch
// deploy leaves the core protocol operationally unpaused — it calls `Lido.resume()`
// and sets the staking rate limit (step 0155), and resumes WithdrawalQueue + VEBO
// even without Dual Governance (step 0145). Default OFF preserves the historical
// paused bootstrap state where the protocol is resumed by governance after deploy.
export function isProtocolActivationEnabled(): boolean {
  return isTruthyEnv("PROTOCOL_ACTIVATION_ENABLED");
}
