import { ethers } from "hardhat";
import { readEDFUpgradeParameters } from "scripts/utils/upgrade";

import { HashConsensus__factory, IEDFDepositSecurityModule__factory, StakingRouter__factory } from "typechain-types";

import { advanceChainTime, getAddress, getCurrentBlockTimestamp, log, readNetworkState, Sk } from "lib";

export async function main() {
  const state = readNetworkState();
  const dsm = IEDFDepositSecurityModule__factory.connect(getAddress(Sk.depositSecurityModule, state), ethers.provider);
  const stakingRouter = StakingRouter__factory.connect(getAddress(Sk.stakingRouter, state), ethers.provider);
  const moduleIds = await stakingRouter.getStakingModuleIds();

  let maxDistance = 0n;
  for (const moduleId of moduleIds) {
    if (!(await dsm.isMinDepositDistancePassed(moduleId))) {
      const distance = await stakingRouter.getStakingModuleMinDepositBlockDistance(moduleId);
      if (distance > maxDistance) maxDistance = distance;
    }
  }

  if (maxDistance === 0n) {
    log.success("DSM minimum deposit distance is already satisfied");
  } else {
    const blocksToMine = maxDistance + 1n;
    await ethers.provider.send("hardhat_mine", [ethers.toQuantity(blocksToMine)]);

    for (const moduleId of moduleIds) {
      if (!(await dsm.isMinDepositDistancePassed(moduleId))) {
        throw new Error(`DSM minimum deposit distance is not satisfied for staking module ${moduleId}`);
      }
    }

    log.success(`Mined ${blocksToMine} blocks to satisfy DSM minimum deposit distance`);
  }

  const parameters = readEDFUpgradeParameters();
  let safeFrameTimestamp = 0n;

  for (const committee of parameters.oracleCommittees) {
    const consensus = HashConsensus__factory.connect(committee.consensusContract, ethers.provider);
    const [, report, isProcessing] = await consensus.getConsensusState();
    if (report === ethers.ZeroHash && !isProcessing) continue;

    const [refSlot] = await consensus.getCurrentFrame();
    const [, epochsPerFrame] = await consensus.getFrameConfig();
    const [slotsPerEpoch, secondsPerSlot, genesisTime] = await consensus.getChainConfig();
    const nextFrameStartSlot = refSlot + 1n + epochsPerFrame * slotsPerEpoch;
    const nextFrameTimestamp = genesisTime + nextFrameStartSlot * secondsPerSlot;
    if (nextFrameTimestamp > safeFrameTimestamp) safeFrameTimestamp = nextFrameTimestamp;
  }

  const currentTimestamp = await getCurrentBlockTimestamp();
  if (safeFrameTimestamp > currentTimestamp) {
    await advanceChainTime(safeFrameTimestamp - currentTimestamp);
    log.success(`Advanced to timestamp ${safeFrameTimestamp} with clean oracle frames`);
  }

  for (const committee of parameters.oracleCommittees) {
    const consensus = HashConsensus__factory.connect(committee.consensusContract, ethers.provider);
    const [, report, isProcessing] = await consensus.getConsensusState();
    if (report !== ethers.ZeroHash || isProcessing) {
      throw new Error(`HashConsensus ${committee.id} is not in a clean oracle frame`);
    }
  }
}
