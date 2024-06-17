import hre from "hardhat";

import { ether, impersonate } from "lib";

import { ProtocolDiscoveryService } from "./ProtocolDiscoveryService";

export class Protocol extends ProtocolDiscoveryService {
  constructor() {
    super();
  }

  async votingSigner() {
    const signer = await hre.ethers.getSigner(this.votingAddress);
    return impersonate(signer.address, ether("100"));
  }

  async agentSigner() {
    const signer = await hre.ethers.getSigner(this.agentAddress);
    return impersonate(signer.address, ether("100"));
  }

  async unpauseStaking() {
    const { lido } = await this.discover();

    if (await lido.isStakingPaused()) {
      const votingSigner = await this.votingSigner();
      await lido.connect(votingSigner).resume();
    }
  }

  async unpauseWithdrawalQueue() {
    const { withdrawalQueue } = await this.discover();

    if (await withdrawalQueue.isPaused()) {
      const resumeRole = await withdrawalQueue.RESUME_ROLE();
      const agentSigner = await this.agentSigner();
      const agentSignerAddress = await agentSigner.getAddress();

      await withdrawalQueue.connect(agentSigner).grantRole(resumeRole, agentSignerAddress);
      await withdrawalQueue.connect(agentSigner).resume();
      await withdrawalQueue.connect(agentSigner).revokeRole(resumeRole, agentSignerAddress);
    }
  }
}

export { Contracts } from "./Contracts";
