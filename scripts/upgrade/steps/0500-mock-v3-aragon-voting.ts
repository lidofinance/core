import { mockDGAragonVoting } from "scripts/utils/upgrade";

import { time } from "@nomicfoundation/hardhat-network-helpers";

import { IEmergencyProtectedTimelock, V3Template, Voting } from "typechain-types";

import { loadContract } from "lib/contract";
import { getAddress, readNetworkState, Sk } from "lib/state-file";

const SECONDS_PER_DAY = 86400n;

export async function getFullVotingDuration(): Promise<bigint> {
  const state = readNetworkState();
  const votingAddress = state[Sk.appVoting].proxy.address;
  const voting = await loadContract<Voting>("Voting", votingAddress);
  const timelock = await loadContract<IEmergencyProtectedTimelock>(
    "IEmergencyProtectedTimelock",
    state[Sk.dgEmergencyProtectedTimelock].proxy.address,
  );

  const voteTime = await voting.voteTime();
  const afterSubmitDelay = await timelock.getAfterSubmitDelay();
  const afterScheduleDelay = await timelock.getAfterScheduleDelay();

  return voteTime + afterSubmitDelay + afterScheduleDelay;
}

export async function setValidUpgradeTimestamp(beforeStart: boolean, template: V3Template): Promise<bigint> {
  const disabledBefore = await template.DISABLED_BEFORE();
  const enabledDaySpanStart = await template.ENABLED_DAY_SPAN_START();
  const enabledDaySpanEnd = await template.ENABLED_DAY_SPAN_END();

  const fullVotingDuration = await getFullVotingDuration();

  // Set to one day after disabledBefore - voting length
  const validDate = disabledBefore + SECONDS_PER_DAY - (beforeStart ? fullVotingDuration : 0n);
  // Calculate middle of the daily time window
  const midWindow = (enabledDaySpanStart + enabledDaySpanEnd) / 2n;
  // Align to start of day and add the time window offset
  const validTimestamp = (validDate / SECONDS_PER_DAY) * SECONDS_PER_DAY + midWindow;

  await time.setNextBlockTimestamp(validTimestamp);
  return validTimestamp;
}

export async function main(): Promise<ReturnType<typeof mockDGAragonVoting>> {
  const state = readNetworkState();
  const template = await loadContract<V3Template>("V3Template", state[Sk.v3Template].address);

  // Set timestamp before voting to account for voting duration
  await setValidUpgradeTimestamp(true, template);

  const votingDescription = "V3 Lido Upgrade description placeholder";
  const proposalMetadata = "V3 Lido Upgrade proposal metadata placeholder";
  return mockDGAragonVoting(getAddress(Sk.v3VoteScript, state), votingDescription, proposalMetadata, state);
}
