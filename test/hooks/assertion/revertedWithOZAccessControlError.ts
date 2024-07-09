/**
 * Custom Chai assertions along with types should be defined in this file.
 * The file will be auto-included in the test suite by the chai setup, no need to import it.
 */
import { Assertion, expect, util } from "chai";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  export namespace Chai {
    interface Assertion {
      /**
       * Asserts that the transaction has been reverted with the expected OZ access control error.
       *
       * @param {string} address - The address of the account that is missing the role.
       * @param {string} role - The byte32 role that is missing.
       */
      revertedWithOZAccessControlError(address: string, role: string): Promise<void>;
    }
  }
}

Assertion.addMethod("revertedWithOZAccessControlError", async function (address: string, role: string) {
  const ctx = util.flag(this, "object");

  try {
    await ctx;
  } catch (error) {
    const msg = (error as Error).message.toUpperCase();
    const reason = `AccessControl: account ${address} is missing role ${role}`;

    expect(msg).to.equal(
      `VM Exception while processing transaction: reverted with reason string '${reason}'`.toUpperCase(),
    );
    return;
  }

  throw new Error(
    `Transaction has been executed without revert. Expected access control error for ${address} without role: ${role}`,
  );
});
