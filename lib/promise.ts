import { expect } from "chai";

// a helper function that acts as "named" Promise.all, e.g.
// instead of an array of promises, it accepts an object
// where keys are arbitrary strings and values are promises and
// returns the same-shape object but with values resolved.
export async function batch<T extends Record<string, Promise<unknown>>>(
  promises: T,
): Promise<{ [K in keyof T]: Awaited<T[K]> }> {
  const keys = Object.keys(promises) as (keyof T)[];
  const values = await Promise.all(keys.map((key) => promises[key]));

  const result: { [K in keyof T]?: Awaited<T[K]> } = {};
  keys.forEach((key, index) => {
    result[key] = values[index];
  });

  return result as { [K in keyof T]: Awaited<T[K]> };
}

type MaybePromise<T> = PromiseLike<T> | T;
type MultiEqualsEntry<T = unknown> = [MaybePromise<T>, MaybePromise<T>, string?];

// Accepts a list of [promise/value, expected, optionalMessage] pairs and asserts each in order.
// All actuals are resolved in parallel via Promise.all.
export async function mEqual(entries: MultiEqualsEntry[]): Promise<void> {
  const actuals = await Promise.all(entries.map(([actual]) => Promise.resolve(actual)));
  const expecteds = await Promise.all(entries.map(([, expected]) => Promise.resolve(expected)));

  entries.forEach(([, , message], idx) => {
    const actual = actuals[idx];
    const expected = expecteds[idx];

    const bothAreReferenceValues =
      actual !== null && expected !== null && typeof actual === "object" && typeof expected === "object";

    if (bothAreReferenceValues) {
      expect(actual).to.deep.equal(expected, message);
    } else {
      expect(actual).to.equal(expected, message);
    }
  });
}
