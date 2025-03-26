import { expect } from "chai";

import { certainAddress, impersonate, log } from "lib";

import { ProtocolContext } from "../types";

/**
 * Ensures that the DSM has the required number of guardians and quorum.
 */
export const ensureDsmGuardians = async (ctx: ProtocolContext, minGuardiansCount: bigint, quorum: bigint) => {
  const { depositSecurityModule: dsm } = ctx.contracts;

  const guardians = await dsm.getGuardians();
  const addresses = guardians.map((address) => address.toLowerCase());

  if (addresses.length >= minGuardiansCount) {
    log.debug("DSM guardians count is sufficient", {
      "Min guardians count": minGuardiansCount,
      "Guardians count": addresses.length,
      "Guardians": addresses.join(", "),
    });
    return;
  }

  const ownerSigner = await impersonate(await dsm.getOwner());

  let count = addresses.length;
  const newGuardians: string[] = [];
  while (count < minGuardiansCount) {
    log.warning(`Adding DSM guardian ${count}`);

    const address = certainAddress(`dsm_guardian_${count}`);
    newGuardians.push(address);

    count++;
  }

  await dsm.connect(ownerSigner).addGuardians(newGuardians, quorum);

  log.debug("Checked DSM guardians count", {
    "Min guardians count": minGuardiansCount,
    "Guardians count": count,
    "Added guardians": newGuardians.join(", "),
  });

  const guardiansAfter = await dsm.getGuardians();
  expect(guardiansAfter.length).to.be.gte(minGuardiansCount);
};

/**
 * Removes all existing guardians and sets a single guardian with quorum of 1
 */
export const setSingleGuardian = async (ctx: ProtocolContext, guardian: string) => {
  const { depositSecurityModule: dsm } = ctx.contracts;
  const ownerSigner = await impersonate(await dsm.getOwner());

  // Remove all existing guardians
  const guardians = await dsm.getGuardians();
  for (const existingGuardian of guardians) {
    await dsm.connect(ownerSigner).removeGuardian(existingGuardian, 1);
  }

  // Add single guardian with quorum 1
  await dsm.connect(ownerSigner).addGuardians([guardian], 1);

  log.debug("Set single DSM guardian", {
    Guardian: guardian,
  });

  const guardiansAfter = await dsm.getGuardians();
  expect(guardiansAfter.length).to.equal(1);
  expect(guardiansAfter[0]).to.equal(guardian);
};
