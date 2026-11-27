/* The stable partition the TypeScript 7 parity sweep uses when it runs as several tasks. Vercel CI ends a task at
 * 900 seconds and the full sweep outgrew it; GitHub Actions runs it whole. The partition is by position in the
 * sorted fixture list, so every shard sees the same files on every machine and the shards' union is every fixture
 * exactly once. */

/** Parses `"i/n"` (1-based) into `{ index, total }`; an unset value means no sharding. */
export function parseShard(raw) {
  if (raw === undefined || raw === "") return null;
  const match = /^(\d+)\/(\d+)$/.exec(raw);
  if (match === null) throw new Error('the shard must look like "i/n"');
  const index = Number(match[1]);
  const total = Number(match[2]);
  if (total < 1 || index < 1 || index > total)
    throw new Error(`shard ${raw} is outside 1..${total}`);
  return { index, total };
}

/** The items one shard owns, in their original order. */
export function shardItems(items, shard) {
  if (shard === null) return items;
  return items.filter((_, position) => position % shard.total === shard.index - 1);
}
