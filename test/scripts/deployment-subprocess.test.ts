import { expect } from "chai";
import { explorerVerificationArgs, runExternal } from "scripts/utils/subprocess";
import { inspect } from "util";

describe("Deployment subprocesses", () => {
  it("does not request explorer verification from an inherited API key", () => {
    expect(explorerVerificationArgs({ ETHERSCAN_API_KEY: "secret" })).to.deep.equal([]);
    expect(explorerVerificationArgs({ VERIFY_ON_EXPLORER: "false", ETHERSCAN_API_KEY: "secret" })).to.deep.equal([]);
  });

  it("requires a key for explicit verification and passes it as one argument", () => {
    expect(() => explorerVerificationArgs({ VERIFY_ON_EXPLORER: "true" })).to.throw("requires ETHERSCAN_API_KEY");
    expect(
      explorerVerificationArgs({ VERIFY_ON_EXPLORER: "true", ETHERSCAN_API_KEY: "key with spaces" }),
    ).to.deep.equal(["--verify", "--etherscan-api-key", "key with spaces"]);
  });

  it("accepts numeric and case-insensitive opt-ins, and rejects unknown values", () => {
    for (const value of ["1", "TRUE", "True"]) {
      expect(explorerVerificationArgs({ VERIFY_ON_EXPLORER: value, ETHERSCAN_API_KEY: "secret" })).to.deep.equal([
        "--verify",
        "--etherscan-api-key",
        "secret",
      ]);
    }
    expect(explorerVerificationArgs({ VERIFY_ON_EXPLORER: "0" })).to.deep.equal([]);
    expect(() => explorerVerificationArgs({ VERIFY_ON_EXPLORER: "yes" })).to.throw("must be true, false, 1, or 0");
  });

  it("does not attach credential arguments to failed process errors", () => {
    const secret = "private-key-and-api-key-sentinel";
    let failure: unknown;
    try {
      runExternal(process.execPath, ["-e", "process.exit(7)", secret], process.cwd());
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(inspect(failure, { depth: null }))
      .to.include("status 7")
      .and.not.include(secret);
  });

  it("does not attach arguments when a process cannot start", () => {
    let failure: unknown;
    try {
      runExternal("missing-deployment-executable", ["secret-sentinel"], process.cwd());
    } catch (error) {
      failure = error;
    }
    expect(failure).to.be.instanceOf(Error);
    expect(inspect(failure, { depth: null }))
      .to.include("could not start (ENOENT)")
      .and.not.include("secret-sentinel");
  });

  it("accepts a successful subprocess", () => {
    expect(() => runExternal(process.execPath, ["-e", "process.exit(0)"], process.cwd())).not.to.throw();
  });
});
