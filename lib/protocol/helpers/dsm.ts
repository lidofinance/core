import { expect } from "chai";
import { ethers } from "hardhat";

import { impersonate, log } from "lib";

import { ProtocolContext } from "../types";

import { deployDelegationContract } from "./edf";

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
  const [delegationOwner, ...delegates] = await ethers.getSigners();
  if (delegates.length === 0) throw new Error("No test signers are available for DSM guardians");

  let count = addresses.length;
  const newGuardians: string[] = [];
  while (count < minGuardiansCount) {
    const delegate = delegates[count % delegates.length];
    const { address } = await deployDelegationContract(delegationOwner, delegate.address);
    newGuardians.push(address);

    log.debug(`Deployed DSM guardian`, { Count: count, Address: address, Delegate: delegate.address });

    count++;
  }

  await (await dsm.connect(ownerSigner).addGuardians(newGuardians, quorum)).wait();

  log.debug("Checked DSM guardians count", {
    "Min guardians count": minGuardiansCount,
    "Guardians count": count,
    "Added guardians": newGuardians.join(", "),
  });

  const guardiansAfter = await dsm.getGuardians();
  expect(guardiansAfter.length).to.be.gte(minGuardiansCount);
};

export const setGuardians = async (ctx: ProtocolContext, guardiansToSet: string[], quorum: bigint) => {
  const { depositSecurityModule: dsm } = ctx.contracts;
  const ownerSigner = await impersonate(await dsm.getOwner());

  // Remove all existing guardians
  const guardians = await dsm.getGuardians();
  for (const existingGuardian of guardians) {
    await (await dsm.connect(ownerSigner).removeGuardian(existingGuardian, 0)).wait();
  }

  await (await dsm.connect(ownerSigner).addGuardians(guardiansToSet, quorum)).wait();

  log.debug("Set DSM guardians", {
    Guardians: guardiansToSet.join(", "),
    Quorum: quorum,
  });

  const guardiansAfter = await dsm.getGuardians();
  expect(guardiansAfter).to.deep.equal(guardiansToSet);
  expect(await dsm.getGuardianQuorum()).to.equal(quorum);
};

/**
 * Removes all existing guardians and sets a single guardian with quorum of 1
 */
export const setSingleGuardian = async (ctx: ProtocolContext, guardian: string) => {
  await setGuardians(ctx, [guardian], 1n);
};
