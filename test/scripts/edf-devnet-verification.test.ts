import { expect } from "chai";
import { ethers } from "hardhat";
import {
  buildEDFDevnetVerificationPlan,
  buildForgeVerifyArgs,
  isBlockscoutSourceVerified,
} from "scripts/utils/edf-devnet-verification";

import { DeploymentState, Sk } from "lib";

const REF = "557299104ad3eb1a74198933bd016328c490e276";
const FACTORY = "0x0000000000000000000000000000000000000001";
const INSTANCE = "0x0000000000000000000000000000000000000002";
const OWNER = "0x0000000000000000000000000000000000000003";
const DELEGATE = "0x0000000000000000000000000000000000000004";

function makeState(): DeploymentState {
  return {
    [Sk.chainId]: 32382,
    [Sk.delegationFactory]: {
      address: FACTORY,
      repository: "https://github.com/lidofinance/execution-delegation-framework.git",
      ref: REF,
      deployArtifact: {
        "DelegationFactory": FACTORY,
        "git-ref": REF,
      },
      delegationContracts: {
        "dsm-guardian-01": {
          address: INSTANCE,
          owner: OWNER,
          delegate: DELEGATE,
          cooldown: 0,
        },
      },
    },
  };
}

describe("EDF devnet verification", () => {
  it("builds Factory and DelegationContract verification targets from state", () => {
    const plan = buildEDFDevnetVerificationPlan(makeState());

    expect(plan.ref).to.equal(REF);
    expect(plan.targets).to.deep.equal([
      {
        label: "DelegationFactory",
        address: FACTORY,
        contract: "src/DelegationFactory.sol:DelegationFactory",
      },
      {
        label: "DelegationContract dsm-guardian-01",
        address: INSTANCE,
        contract: "src/DelegationContract.sol:DelegationContract",
        constructorArgs: ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "uint256"],
          [OWNER, DELEGATE, 0],
        ),
      },
    ]);
  });

  it("builds Blockscout forge arguments", () => {
    const target = buildEDFDevnetVerificationPlan(makeState()).targets[1];

    expect(buildForgeVerifyArgs(target, 32382n, "https://blockscout.example/api")).to.deep.equal([
      "verify-contract",
      INSTANCE,
      "src/DelegationContract.sol:DelegationContract",
      "--chain",
      "32382",
      "--verifier",
      "blockscout",
      "--verifier-url",
      "https://blockscout.example/api",
      "--compiler-version",
      "0.8.35",
      "--watch",
      "--constructor-args",
      target.constructorArgs,
    ]);
  });

  it("rejects a deploy artifact from another EDF commit", () => {
    const state = makeState();
    state[Sk.delegationFactory].deployArtifact["git-ref"] = "a".repeat(40);

    expect(() => buildEDFDevnetVerificationPlan(state)).to.throw("does not match state ref");
  });

  it("accepts only a Blockscout response with source code", () => {
    expect(isBlockscoutSourceVerified({ result: [{ SourceCode: "contract DelegationFactory {}" }] })).to.equal(true);
    expect(isBlockscoutSourceVerified({ result: [{ Address: FACTORY }] })).to.equal(false);
    expect(isBlockscoutSourceVerified({ message: "NOTOK", result: "Unable to verify" })).to.equal(false);
  });
});
