/* The one placement rule behind every cost-balanced split: the CI planner
 * (scripts/ci-test-plan.mjs) and the harness (shard.ts) both call it, so the
 * planner's account of a shard is what the shard's processes then do. */

/** Places weighted items on slices, longest first (equal weights by key), each
 * on the slice that carries the least so far (the lowest such slice). `loads`
 * holds what every slice already carries and receives each item's weight.
 * Returns each key's slice, 0-based. The result depends only on the items'
 * keys and weights and on `loads`, never on the order the items arrive in, so
 * every process that is given the same inputs builds the same partition.
 *
 * @param {readonly { key: string, weight: number }[]} items
 * @param {number[]} loads
 * @returns {Map<string, number>}
 */
export function placeLongestFirst(items, loads) {
  const ranked = [...items].sort(
    (a, b) => b.weight - a.weight || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  const slices = new Map();
  for (const { key, weight } of ranked) {
    let slice = 0;
    for (let candidate = 1; candidate < loads.length; candidate++)
      if (loads[candidate] < loads[slice]) slice = candidate;
    loads[slice] += weight;
    slices.set(key, slice);
  }
  return slices;
}
