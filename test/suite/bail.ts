/**
 * Bail on failure if any test in the current suite has failed.
 * Can be used as a `beforeEach` hook to skip tests that are dependent on the previous tests passing.
 */
export function bailOnFailure(this: Mocha.Context) {
  if (this.currentTest?.parent?.tests.some((t) => t.state === "failed")) {
    this.skip();
  }
}
