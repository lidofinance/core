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

// `DG_DEPLOYMENT_ENABLED` is opt-out: default ON, disabled via any of the
// common falsy strings ("false", "0", "off", "no" — case-insensitive). The
// strict `=== "false"` check used previously rejected the rest, which
// surprised users typing `DG_DEPLOYMENT_ENABLED=0`.
export function isDGDeploymentEnabled(): boolean {
  const v = process.env.DG_DEPLOYMENT_ENABLED?.trim().toLowerCase();
  return !v || !FALSY_VALUES.has(v);
}
