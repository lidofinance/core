import { BytesLike, ethers } from "ethers";
import { encodeCallScript, EvmScriptHex, VoteItem } from "scripts/utils/omnibus";

import { EDFUpgradeManifest, EDFUpgradeParameters, validateEDFUpgradeManifest } from "lib/config-schemas";

export type EDFDevnetCommittee = {
  id: EDFUpgradeParameters["oracleCommittees"][number]["id"];
  consensusContract: string;
  members: string[];
  quorum: number;
};

export type EDFDevnetUpgradeInput = {
  chainId: number;
  repository: string;
  ref: string;
  owner: string;
  cooldown: number;
  guardians: string[];
  guardianDelegates: string[];
  guardianQuorum: number;
  maxOperatorsPerUnvetting: number;
  pauseIntentValidityPeriodBlocks: number;
  oracleCommittees: EDFDevnetCommittee[];
  oracleDelegates: string[];
  depositorDelegate: string;
  topUpGateway: string;
};

function normalizeAddress(address: string): string {
  return ethers.getAddress(address);
}

function memberId(prefix: string, index: number): string {
  return `${prefix}-${String(index + 1).padStart(2, "0")}`;
}

export function buildEDFDevnetUpgradeParameters(input: EDFDevnetUpgradeInput): EDFUpgradeManifest {
  const owner = normalizeAddress(input.owner);
  const guardians = input.guardians.map(normalizeAddress);
  const guardianDelegates = input.guardianDelegates.map(normalizeAddress);
  const oracleMemberIds = new Map<string, string>();
  const oracleMembers: string[] = [];

  for (const committee of input.oracleCommittees) {
    for (const member of committee.members.map(normalizeAddress)) {
      const key = member.toLowerCase();
      if (!oracleMemberIds.has(key)) {
        oracleMemberIds.set(key, memberId("oracle-member", oracleMembers.length));
        oracleMembers.push(member);
      }
    }
  }

  const oracleDelegates = input.oracleDelegates.map(normalizeAddress);
  if (guardianDelegates.length !== guardians.length) {
    throw new Error(`Expected ${guardians.length} DSM delegates, got ${guardianDelegates.length}`);
  }
  if (oracleDelegates.length !== oracleMembers.length) {
    throw new Error(`Expected ${oracleMembers.length} oracle delegates, got ${oracleDelegates.length}`);
  }

  const depositorDelegate = normalizeAddress(input.depositorDelegate);
  const delegates = [...guardianDelegates, ...oracleDelegates, depositorDelegate];
  const delegateSet = new Set(delegates.map((address) => address.toLowerCase()));
  if (delegateSet.size !== delegates.length) {
    throw new Error("EDF devnet delegates must be unique");
  }
  const currentMembers = new Set([...guardians, ...oracleMembers].map((address) => address.toLowerCase()));
  const reusedMember = delegates.find((address) => currentMembers.has(address.toLowerCase()));
  if (reusedMember) {
    throw new Error(`EDF devnet delegate ${reusedMember} is already a DSM guardian or oracle member`);
  }

  return validateEDFUpgradeManifest({
    chainId: input.chainId,
    executionDelegationFramework: {
      repository: input.repository,
      ref: input.ref,
      factory: {},
    },
    guardians: Object.fromEntries(
      guardians.map((currentAddress, index) => [
        memberId("dsm-guardian", index),
        {
          currentAddress,
          owner,
          delegate: guardianDelegates[index],
          cooldown: input.cooldown,
        },
      ]),
    ),
    oracleMembers: Object.fromEntries(
      oracleMembers.map((currentAddress, index) => [
        memberId("oracle-member", index),
        {
          currentAddress,
          owner,
          delegate: oracleDelegates[index],
          cooldown: input.cooldown,
        },
      ]),
    ),
    depositSecurityModule: {
      maxOperatorsPerUnvetting: input.maxOperatorsPerUnvetting,
      pauseIntentValidityPeriodBlocks: input.pauseIntentValidityPeriodBlocks,
      quorum: input.guardianQuorum,
    },
    topUpGateway: {
      address: normalizeAddress(input.topUpGateway),
      depositorContract: {
        id: memberId("depositor", 0),
        owner,
        delegate: depositorDelegate,
        cooldown: input.cooldown,
      },
    },
    oracleCommittees: Object.fromEntries(
      input.oracleCommittees.map((committee) => {
        const memberIds = committee.members.map(
          (oldMember) => oracleMemberIds.get(normalizeAddress(oldMember).toLowerCase())!,
        );
        const defaultMemberIds = oracleMembers.map((_, index) => memberId("oracle-member", index));
        return [
          committee.id,
          {
            consensusContract: normalizeAddress(committee.consensusContract),
            quorum: committee.quorum,
            ...(memberIds.length === defaultMemberIds.length &&
            memberIds.every((id, index) => id === defaultMemberIds[index])
              ? {}
              : { memberIds }),
          },
        ];
      }),
    ),
    upgradeVoteScript: {},
  });
}

export function buildEDFDevnetExecutionScript(voteItems: readonly VoteItem[]): EvmScriptHex {
  return encodeCallScript(voteItems.map(({ call }) => call));
}

export function buildEDFDevnetNewVoteScript(votingAddress: string, newVoteCalldata: BytesLike): EvmScriptHex {
  return encodeCallScript([{ to: votingAddress, data: newVoteCalldata }]);
}
