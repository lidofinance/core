import { expect } from "chai";
import {
  buildEDFDevnetExecutionScript,
  buildEDFDevnetNewVoteScript,
  buildEDFDevnetUpgradeParameters,
} from "scripts/utils/edf-devnet";

import * as toml from "@iarna/toml";

import { validateEDFUpgradeParameters } from "lib/config-schemas";

describe("EDF devnet parameters", () => {
  it("uses one delegation contract per devnet guardian and oracle wallet", () => {
    const owner = "0x8943545177806ED17B9F23F0a21ee5948eCaa776";
    const guardians = ["0xAe95d8DA9244C37CaC0a3e16BA966a8e852Bb6D6", "0x2c57d1CFC6d5f8E4182a56b4cf75421472eBAEa4"];
    const oracleMembers = [
      "0x614561D2d143621E126e87831AEF287678B442b8",
      "0xf93Ee4Cf8c6c40b329b0c0626F28333c132CF241",
      "0x802dCbE1B1A97554B4F50DB5119E37E8e7336417",
    ];
    const guardianDelegates = [
      "0x741bFE4802cE1C4b5b00F9Df2F5f179A1C89171A",
      "0xc3913d4D8bAb4914328651C2EAE817C8b78E1f4c",
    ];
    const oracleDelegates = [
      "0x65D08a056c17Ae13370565B04cF77D2AfA1cB9FA",
      "0x3e95dFbBaF6B348396E6674C7871546dCC568e56",
      "0x5918b2e647464d4743601a865753e64C8059Dc4F",
    ];
    const committeeIds = [
      "accounting-oracle",
      "validators-exit-bus-oracle",
      "csm-fee-oracle",
      "curated-module-fee-oracle",
    ] as const;
    const consensusContracts = [
      "0x0000000000000000000000000000000000000101",
      "0x0000000000000000000000000000000000000102",
      "0x0000000000000000000000000000000000000103",
      "0x0000000000000000000000000000000000000104",
    ];

    const parameters = buildEDFDevnetUpgradeParameters({
      chainId: 32382,
      repository: "https://github.com/lidofinance/execution-delegation-framework.git",
      ref: "feat/local-devnet",
      owner,
      cooldown: 0,
      guardians,
      guardianDelegates,
      guardianQuorum: 2,
      maxOperatorsPerUnvetting: 200,
      pauseIntentValidityPeriodBlocks: 6646,
      oracleCommittees: committeeIds.map((id, index) => ({
        id,
        consensusContract: consensusContracts[index],
        members: oracleMembers,
        quorum: 2,
      })),
      oracleDelegates,
    });

    expect(parameters.chainId).to.equal(32382);
    expect(parameters.executionDelegationFramework.delegationContracts).to.have.length(5);
    expect(parameters.executionDelegationFramework.delegationContracts.map(({ id }) => id)).to.deep.equal([
      "dsm-guardian-01",
      "dsm-guardian-02",
      "oracle-member-01",
      "oracle-member-02",
      "oracle-member-03",
    ]);
    expect(parameters.executionDelegationFramework.delegationContracts.map(({ delegate }) => delegate)).to.deep.equal([
      ...guardianDelegates,
      ...oracleDelegates,
    ]);
    expect(parameters.oracleCommittees).to.have.length(4);
    for (const committee of parameters.oracleCommittees) {
      expect(committee.memberMappings.map(({ delegationContractId }) => delegationContractId)).to.deep.equal([
        "oracle-member-01",
        "oracle-member-02",
        "oracle-member-03",
      ]);
    }

    const encoded = toml.stringify(parameters as unknown as Parameters<typeof toml.stringify>[0]);
    expect(validateEDFUpgradeParameters(toml.parse(encoded))).to.deep.equal(parameters);
  });

  it("builds the direct Aragon scripts outside the Hoodi voting contract", () => {
    const executionScript = buildEDFDevnetExecutionScript([
      {
        description: "Direct devnet action",
        call: {
          to: "0x0000000000000000000000000000000000000011",
          data: "0xaabb",
        },
      },
    ]);
    const tokenManagerScript = buildEDFDevnetNewVoteScript("0x0000000000000000000000000000000000000022", "0xcc");

    expect(executionScript).to.equal("0x00000001000000000000000000000000000000000000001100000002aabb");
    expect(tokenManagerScript).to.equal("0x00000001000000000000000000000000000000000000002200000001cc");
  });
});
