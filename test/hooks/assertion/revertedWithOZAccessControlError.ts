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
  const reason = `AccessControl: account ${address.toLowerCase()} is missing role ${role}`;

  await expect(ctx).to.be.revertedWith(reason);
});
