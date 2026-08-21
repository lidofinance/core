import { expect } from "chai";
import fs from "fs";
import {
  buildEDFDevnetExecutionScript,
  buildEDFDevnetNewVoteScript,
  buildEDFDevnetUpgradeParameters,
} from "scripts/utils/edf-devnet";
import { buildDelegationDeploymentPlan, getDelegationContractsForScope } from "scripts/utils/edf-upgrade";

import * as toml from "@iarna/toml";

import { validateEDFUpgradeParameters } from "lib/config-schemas";

describe("EDF devnet parameters", () => {
  it("expands the maintained manifests to the expected voting topology", () => {
    const hoodiManifest = toml.parse(fs.readFileSync("scripts/upgrade/upgrade-params-hoodi.toml", "utf8"));
    const hoodi = validateEDFUpgradeParameters(hoodiManifest);
    const guardians = [
      {
        id: "lido-dev-team",
        oldMember: "0x4E93C8c7B06F1CEEb03A8e13B0371b35F93d3257",
        address: "0x56a1B0b5074818D568D6608dc07353e81b4b53ec",
      },
      {
        id: "p2p",
        oldMember: "0x89C102120452AfdFb63f2D4231C5CE3e939f393b",
        address: "0x89e1bEBAf6857312bCDc313B93F29aB9cA98000f",
      },
      {
        id: "staking-facilities",
        oldMember: "0x1be2A219CBD0F18B825a4dDd580F7b3B33Bacb41",
        address: "0x901789EA029B3c7CEa47019d6Df3C5973212976D",
      },
      {
        id: "blockscape",
        oldMember: "0xEf302FFC6830FbC464cDFFA84Fa4d5699aA8f06A",
        address: "0xa66FDd65Cfc78964A62b5Ec50E5b0Afd0e52D610",
      },
      {
        id: "stakefish",
        oldMember: "0xcc1fFeb60ee3A3Cb6711E5D191339b0aF263328C",
        address: "0x4EEC6BEd8d5E45f0a6a99F067bC5F6370f2f7221",
      },
      {
        id: "stakely",
        // Kiln's old DSM guardian address is replaced by the Stakely holder's delegation contract.
        oldMember: "0x8C4C15870d27c1194B6893F6B94DD0CE9C2c8ba2",
        address: "0x03224cFc446F3166c83E875095e872DD1E098076",
      },
    ];
    const guardianMappings = guardians.map(({ id: delegationContractId, oldMember }) => ({
      oldMember,
      delegationContractId,
    }));
    const depositor = {
      id: "depositor-bot",
      address: "0x25636798f6E716b2e6b7dEA8ED52a45271768D7A",
    };
    const oracleMembers = Object.fromEntries([
      ["oracle-member-01", "0x43C45C2455C49eed320F463fF4f1Ece3D2BF5aE2"],
      ["oracle-member-02", "0x948A62cc0414979dc7aa9364BA5b96ECb29f8736"],
      ["oracle-member-03", "0x1932f53B1457a5987791a40Ba91f71c5Efd5788F"],
      ["oracle-member-04", "0xf7aE520e99ed3C41180B5E12681d31Aa7302E4e5"],
      ["oracle-member-05", "0x99B2B75F490fFC9A29E4E1f5987BE8e30E690aDF"],
      ["oracle-member-06", "0x219743f1911d84B32599BdC2Df21fC8Dba6F81a2"],
      ["oracle-member-07", "0xD3b1e36A372Ca250eefF61f90E833Ca070559970"],
      ["oracle-member-08", "0x4c75FA734a39f3a21C57e583c1c29942F021C6B7"],
      ["oracle-member-09", "0xfe43A8B0b481Ae9fB1862d31826532047d2d538c"],
      ["oracle-member-10", "0xcA80ee7313A315879f326105134F938676Cfd7a9"],
    ]);
    const oracleMemberIds = Object.keys(oracleMembers);
    const memberMappings = (ids: string[]) =>
      ids.map((delegationContractId) => ({ oldMember: oracleMembers[delegationContractId], delegationContractId }));

    expect(hoodi.executionDelegationFramework.delegationContracts.map(({ id }) => id)).to.deep.equal([
      ...guardians.map(({ id }) => id),
      ...oracleMemberIds,
      depositor.id,
    ]);
    expect(hoodi.executionDelegationFramework.delegationContracts.map(({ address }) => address)).to.deep.equal([
      ...guardians.map(({ address }) => address),
      ...Array(oracleMemberIds.length).fill(undefined),
      depositor.address,
    ]);
    expect(
      buildDelegationDeploymentPlan(hoodi.executionDelegationFramework.delegationContracts).map(({ id, action }) => ({
        id,
        action,
      })),
    ).to.deep.equal([
      ...guardians.map(({ id }) => ({ id, action: "reuse" })),
      ...oracleMemberIds.map((id) => ({ id, action: "deploy" })),
      { id: depositor.id, action: "reuse" },
    ]);
    expect(getDelegationContractsForScope(hoodi, "protocol").map(({ id }) => id)).to.deep.equal([
      ...guardians.map(({ id }) => id),
      depositor.id,
    ]);
    expect(hoodi.depositSecurityModule.guardianMappings).to.deep.equal(guardianMappings);
    expect(hoodi.oracleCommittees.map(({ memberMappings: mappings }) => mappings)).to.deep.equal([
      memberMappings(oracleMemberIds),
      memberMappings([
        "oracle-member-10",
        "oracle-member-02",
        "oracle-member-03",
        "oracle-member-04",
        "oracle-member-05",
        "oracle-member-06",
        "oracle-member-07",
        "oracle-member-08",
        "oracle-member-09",
        "oracle-member-01",
      ]),
      memberMappings([
        "oracle-member-04",
        "oracle-member-02",
        "oracle-member-03",
        "oracle-member-06",
        "oracle-member-09",
        "oracle-member-08",
        "oracle-member-07",
        "oracle-member-10",
        "oracle-member-05",
        "oracle-member-01",
      ]),
      memberMappings([
        "oracle-member-04",
        "oracle-member-02",
        "oracle-member-03",
        "oracle-member-06",
        "oracle-member-09",
        "oracle-member-08",
        "oracle-member-07",
        "oracle-member-10",
        "oracle-member-05",
        "oracle-member-01",
      ]),
    ]);
    expect(hoodi.topUpGateway).to.deep.equal({
      address: "0x10DBEb3367876826d00D21718D1d893e0fbD2956",
      delegationContractId: "depositor-bot",
    });
  });

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
    const depositorDelegate = "0x589A698b7b7dA0Bec545177D3963A2741105C7C9";
    const topUpGateway = "0x0000000000000000000000000000000000000201";
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

    const manifest = buildEDFDevnetUpgradeParameters({
      chainId: 32382,
      repository: "https://github.com/lidofinance/execution-delegation-framework.git",
      ref: "main",
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
      depositorDelegate,
      topUpGateway,
    });
    const parameters = validateEDFUpgradeParameters(manifest);

    expect(parameters.chainId).to.equal(32382);
    expect(Object.keys(manifest.guardians)).to.deep.equal(["dsm-guardian-01", "dsm-guardian-02"]);
    expect(Object.keys(manifest.oracleMembers)).to.deep.equal([
      "oracle-member-01",
      "oracle-member-02",
      "oracle-member-03",
    ]);
    expect(
      [...Object.values(manifest.guardians), ...Object.values(manifest.oracleMembers)].map(
        ({ delegationContract }) => delegationContract,
      ),
    ).to.deep.equal(Array(5).fill(""));
    expect(manifest.oracleCommittees["accounting-oracle"].memberIds).to.equal(undefined);
    expect(parameters.executionDelegationFramework.delegationContracts).to.have.length(6);
    expect(parameters.executionDelegationFramework.delegationContracts.map(({ id }) => id)).to.deep.equal([
      "dsm-guardian-01",
      "dsm-guardian-02",
      "oracle-member-01",
      "oracle-member-02",
      "oracle-member-03",
      "depositor-01",
    ]);
    expect(parameters.executionDelegationFramework.delegationContracts.map(({ delegate }) => delegate)).to.deep.equal([
      ...guardianDelegates,
      ...oracleDelegates,
      depositorDelegate,
    ]);
    expect(parameters.topUpGateway).to.deep.equal({
      address: topUpGateway,
      delegationContractId: "depositor-01",
    });
    expect(parameters.oracleCommittees).to.have.length(4);
    for (const committee of parameters.oracleCommittees) {
      expect(committee.memberMappings.map(({ delegationContractId }) => delegationContractId)).to.deep.equal([
        "oracle-member-01",
        "oracle-member-02",
        "oracle-member-03",
      ]);
    }

    const encoded = toml.stringify(manifest as unknown as Parameters<typeof toml.stringify>[0]);
    expect(validateEDFUpgradeParameters(toml.parse(encoded))).to.deep.equal(parameters);
    expect(validateEDFUpgradeParameters(parameters)).to.deep.equal(parameters);
  });

  it("reuses delegation contracts configured next to their members", () => {
    const manifest = {
      chainId: 560048,
      executionDelegationFramework: {
        repository: "https://github.com/lidofinance/execution-delegation-framework.git",
        ref: "main",
        factory: {},
      },
      guardians: {
        "dsm-guardian-01": {
          currentAddress: "0x0000000000000000000000000000000000000001",
          delegationContract: "0x0000000000000000000000000000000000000011",
        },
      },
      oracleMembers: {
        "oracle-member-01": {
          currentAddress: "0x0000000000000000000000000000000000000002",
        },
      },
      depositSecurityModule: {
        maxOperatorsPerUnvetting: 200,
        pauseIntentValidityPeriodBlocks: 6646,
        quorum: 1,
      },
      oracleCommittees: {
        "accounting-oracle": {
          consensusContract: "0x0000000000000000000000000000000000000101",
          quorum: 1,
        },
        "validators-exit-bus-oracle": {
          consensusContract: "0x0000000000000000000000000000000000000102",
          quorum: 1,
        },
        "csm-fee-oracle": {
          consensusContract: "0x0000000000000000000000000000000000000103",
          quorum: 1,
        },
        "curated-module-fee-oracle": {
          consensusContract: "0x0000000000000000000000000000000000000104",
          quorum: 1,
        },
      },
      topUpGateway: {
        address: "0x0000000000000000000000000000000000000201",
        depositorContractId: "dsm-guardian-01",
      },
      upgradeVoteScript: {},
    };

    const parameters = validateEDFUpgradeParameters(manifest);
    expect(parameters.executionDelegationFramework.delegationContracts[0]).to.include({
      id: "dsm-guardian-01",
      address: "0x0000000000000000000000000000000000000011",
    });
    expect(
      buildDelegationDeploymentPlan(parameters.executionDelegationFramework.delegationContracts)[0].action,
    ).to.equal("reuse");
    expect(parameters.topUpGateway.delegationContractId).to.equal("dsm-guardian-01");
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
