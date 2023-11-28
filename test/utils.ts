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
