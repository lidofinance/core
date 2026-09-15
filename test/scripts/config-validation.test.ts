import { expect } from "chai";
import { spawnSync } from "child_process";

function validate(args: string[], env: Record<string, string> = {}) {
  const result = spawnSync(
    process.execPath,
    [
      "--no-experimental-strip-types",
      "--no-experimental-require-module",
      require.resolve("hardhat/internal/cli/bootstrap"),
      "validate-configs",
      ...args,
    ],
    {
      encoding: "utf8",
      timeout: 30_000,
      env: {
        ...process.env,
        UPGRADE_PARAMETERS_FILE: "scripts/upgrade/upgrade-params-mainnet.toml",
        SCRATCH_DEPLOY_CONFIG: "scripts/scratch/deploy-params-testnet.toml",
        ...env,
      } as unknown as NodeJS.ProcessEnv,
    },
  );
  expect(result.error).to.equal(undefined);
  return { status: result.status, output: result.stdout + result.stderr };
}

describe("Configuration consistency coverage", () => {
  for (const silent of [false, true]) {
    const args = silent ? ["--silent"] : [];
    it(`fails explicitly for unmapped EDF parameters (silent=${silent})`, () => {
      const result = validate(args);
      expect(result.status).to.equal(1);
      expect(result.output).to.include("coverage is missing").and.include("0 parameters checked");
      expect(result.output).not.to.include("PASSED");
    });

    it(`reports an explicit skip only when opted in (silent=${silent})`, () => {
      const result = validate([...args, "--allow-uncovered"]);
      expect(result.status).to.equal(0);
      expect(result.output).to.include("SKIPPED").and.include("0 parameters checked");
      expect(result.output).not.to.include("PASSED");
    });
  }

  for (const variable of ["UPGRADE_PARAMETERS_FILE", "SCRATCH_DEPLOY_CONFIG"]) {
    it(`does not bypass invalid ${variable} with --allow-uncovered`, () => {
      const result = validate(["--allow-uncovered", "--silent"], { [variable]: "package.json" });
      expect(result.status).to.equal(1);
      expect(result.output).to.include("Failed to read");
      expect(result.output).not.to.include("SKIPPED");
      expect(result.output).not.to.include("PASSED");
    });
  }
});
