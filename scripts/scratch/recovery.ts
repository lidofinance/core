/** A transfer is complete only when its on-chain postcondition holds (FPF A.15). */
export const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

export async function ensureAuthorityTransfer(
  label: string,
  readAuthority: () => Promise<string>,
  from: string,
  to: string,
  transfer: () => Promise<unknown>,
): Promise<void> {
  const current = await readAuthority();
  if (sameAddress(current, to)) return;
  if (!sameAddress(current, from))
    throw new Error(`${label}: unexpected authority ${current}; expected ${from} or ${to}`);
  await transfer();
  if (!sameAddress(await readAuthority(), to)) throw new Error(`${label}: transfer postcondition failed`);
}

export async function ensureRoleTransfer(
  label: string,
  hasRole: (account: string) => Promise<boolean>,
  from: string,
  to: string,
  grant: () => Promise<unknown>,
  renounce: () => Promise<unknown>,
  deferRenounce = false,
): Promise<void> {
  if (!(await hasRole(to))) {
    if (!(await hasRole(from))) throw new Error(`${label}: neither deployer nor recipient holds admin`);
    await grant();
    if (!(await hasRole(to))) throw new Error(`${label}: recipient admin postcondition failed`);
  }
  if (!deferRenounce && (await hasRole(from))) {
    await renounce();
    if (await hasRole(from)) throw new Error(`${label}: deployer admin renunciation failed`);
  }
}

/** Finalization is atomic; mixed managers indicate an unexpected deployment state. */
export async function ensureFinalized(
  readManagers: () => Promise<string[]>,
  template: string,
  expected: string[],
  finalize: () => Promise<unknown>,
): Promise<void> {
  const matches = (actual: string[]) =>
    actual.length === expected.length && actual.every((a, i) => sameAddress(a, expected[i]));
  const current = await readManagers();
  if (matches(current)) return;
  if (current.length !== expected.length || !current.every((a) => sameAddress(a, template))) {
    throw new Error(`Unexpected finalization permission managers: ${current.join(", ")}`);
  }
  await finalize();
  if (!matches(await readManagers())) throw new Error("Finalization permission-manager postconditions failed");
}
