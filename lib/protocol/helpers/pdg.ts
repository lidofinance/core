import { log } from "lib/log";

import { ProtocolContext } from "../types";

export const ensurePredepositGuaranteeUnpaused = async (ctx: ProtocolContext) => {
  const { predepositGuarantee } = ctx.contracts;

  const paused = await predepositGuarantee.isPaused();
  if (!paused) {
    log.debug("PredepositGuarantee is not paused, skipping");
    return;
  }

  const resumeRole = await predepositGuarantee.RESUME_ROLE();

  const agentSigner = await ctx.getSigner("agent");
  await predepositGuarantee.connect(agentSigner).grantRole(resumeRole, agentSigner.address);
  await predepositGuarantee.connect(agentSigner).resume();
  await predepositGuarantee.connect(agentSigner).revokeRole(resumeRole, agentSigner.address);

  log.success("PredepositGuarantee unpaused successfully");
};
