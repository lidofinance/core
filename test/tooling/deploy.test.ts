import { mock } from "node:test";

import { expect } from "chai";
import { FeeData, parseUnits } from "ethers";
import { ethers } from "hardhat";

import { deployContract } from "lib/deploy";

describe("Deployment fees", () => {
  const envKeys = ["AUTO_FEE", "GAS_PRIORITY_FEE", "GAS_MAX_FEE", "GAS_LIMIT", "DEPLOYER"] as const;
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(async () => {
    savedEnv = { ...process.env };
    delete process.env.AUTO_FEE;
    process.env.GAS_PRIORITY_FEE = "1.5";
    process.env.GAS_MAX_FEE = "20";
    process.env.GAS_LIMIT = "1000000";
    process.env.DEPLOYER = (await ethers.getSigners())[0].address;
  });

  afterEach(() => {
    mock.restoreAll();
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  async function deploy() {
    const contract = await deployContract("NoInterface__Mock", [], process.env.DEPLOYER!, false);
    return contract.deploymentTransaction()!;
  }

  for (const autoFee of [undefined, "false"]) {
    it(`preserves manual fees when AUTO_FEE is ${autoFee}`, async () => {
      if (autoFee !== undefined) process.env.AUTO_FEE = autoFee;
      const feeQuery = mock.method(ethers.provider, "getFeeData", async () => {
        throw new Error("Manual mode must not query fee estimates");
      });
      const tx = await deploy();
      expect(tx.maxPriorityFeePerGas).to.equal(parseUnits("1.5", "gwei"));
      expect(tx.maxFeePerGas).to.equal(parseUnits("20", "gwei"));
      expect(tx.gasLimit).to.equal(1000000n);
      expect(feeQuery.mock.callCount()).to.equal(0);
    });
  }

  it("refreshes provider fees for each deployment and overrides manual values", async () => {
    process.env.AUTO_FEE = "true";
    let maxFee = parseUnits("5", "gwei");
    const priorityFee = parseUnits("0.1", "gwei");
    const feeQuery = mock.method(ethers.provider, "getFeeData", async () => new FeeData(null, maxFee, priorityFee));
    const first = await deploy();
    delete process.env.GAS_PRIORITY_FEE;
    delete process.env.GAS_MAX_FEE;
    maxFee = parseUnits("6", "gwei");
    const second = await deploy();
    expect(first.maxFeePerGas).to.equal(parseUnits("5", "gwei"));
    expect(second.maxFeePerGas).to.equal(maxFee);
    expect(second.maxPriorityFeePerGas).to.equal(priorityFee);
    expect(second.gasLimit).to.equal(1000000n);
    expect(feeQuery.mock.callCount()).to.equal(2);
  });

  it("stops before sending when EIP-1559 fees are unavailable", async () => {
    process.env.AUTO_FEE = "true";
    mock.method(ethers.provider, "getFeeData", async () => new FeeData(1n, null, null));
    const signer = (await ethers.getSigners())[0];
    const nonce = await signer.getNonce();
    await expect(deploy()).to.be.rejectedWith("AUTO_FEE requires EIP-1559 fee data from the provider");
    expect(await signer.getNonce()).to.equal(nonce);
  });
});
