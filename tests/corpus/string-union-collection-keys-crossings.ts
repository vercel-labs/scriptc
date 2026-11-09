// Unit keys that reach a Set or a Map from other positions (an absent
// optional member, a Map miss, a narrowed wider union, parsed JSON), three
// key unions side by side, checked casts back from `unknown`, mutation
// during iteration, and captures in closures, generators and async code.
function show(v: unknown): string {
  return v === null ? "<null>" : v === undefined ? "<undefined>" : typeof v + ":" + String(v);
}
interface Item {
  name: string;
  tag?: string;
  owner: string | null;
  alias?: string | null;
}
const items: Item[] = [
  { name: "a", owner: null },
  { name: "b", tag: "t", owner: "o", alias: null },
  { name: "c", tag: undefined, owner: "o", alias: "al" },
];

const tags = new Set<string | undefined>();
const owners = new Set<string | null>();
const aliases = new Map<string | null | undefined, string[]>();
for (const item of items) {
  tags.add(item.tag);
  owners.add(item.owner);
  const list = aliases.get(item.alias);
  if (list === undefined) aliases.set(item.alias, [item.name]);
  else list.push(item.name);
}
console.log(tags.size, tags.has(undefined), tags.has(items[0].tag), tags.has("t"));
console.log(owners.size, owners.has(null), owners.has(items[0].owner));
console.log(aliases.size, aliases.get(undefined), aliases.get(null), aliases.get("al"));
for (const [k, v] of aliases) console.log(show(k), v.join("+"));
console.log(tags, owners, aliases);

const lookup = new Map<string, string>([["k", "v"]]);
const misses = new Set<string | undefined>();
misses.add(lookup.get("nope"));
misses.add(lookup.get("k"));
misses.add(["x"].pop());
misses.add([].pop());
console.log(misses.size, misses.has(undefined), [...misses].map(show).join(","));

function narrow(v: string | null | undefined): void {
  if (v !== undefined) owners.add(v);
  if (v !== null) tags.add(v);
  aliases.set(v, ["narrow"]);
}
narrow(null);
narrow(undefined);
narrow("n");
console.log([...owners].map(show).join(","), [...tags].map(show).join(","), [...aliases.keys()].map(show).join(","));

const parsed = JSON.parse('[{"id":"p","parent":null},{"id":"q","parent":"p"},{"id":"r"}]') as {
  id: string;
  parent?: string | null;
}[];
const parents = new Map<string | null | undefined, number>();
for (const row of parsed) parents.set(row.parent, (parents.get(row.parent) ?? 0) + 1);
console.log([...parents].map(([k, n]) => show(k) + "=" + n).join(","));

const dyn: unknown = owners;
const again = dyn as Set<string | null>;
again.add("cast");
console.log(again === owners, owners.has("cast"), again.has(null));
const dynMap: unknown = new Map<unknown, unknown>([
  [null, 1],
  ["s", 2],
]);
const typed = dynMap as Map<string | null, number>;
console.log(typed.get(null), typed.get("s"), typed.size, [...typed.keys()].map(show).join(","));
typed.set(null, 3);
typed.delete("s");
console.log(dynMap);
const dynSet: unknown = new Set<unknown>([undefined, "u", null]);
const typedSet = dynSet as Set<string | null | undefined>;
console.log(typedSet.has(undefined), typedSet.has(null), [...typedSet].map(show).join(","));

const live = new Set<string | null>(["a", null, "b", "c"]);
for (const v of live) {
  if (v === "a") live.delete(null);
  if (v === "b") live.add(null);
  console.log("live", show(v));
}
live.clear();
live.add(null).add(null).add("z");
console.log(live.size, [...live].map(show).join(","));
const sorted = [...new Set<string | null>(["b", null, "a"])].sort((x, y) => (x ?? "").localeCompare(y ?? ""));
console.log(sorted.map(show).join(","));

function counter(): (key: string | null) => number {
  const seen = new Map<string | null, number>();
  return (key) => {
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return n;
  };
}
const count = counter();
console.log(count(null), count("k"), count(null));
function* walk(set: Set<string | undefined>): Generator<string> {
  for (const v of set) yield show(v);
}
console.log([...walk(tags)].join(","));
async function later(set: Set<string | null>): Promise<string> {
  await Promise.resolve();
  set.add(null);
  await Promise.resolve();
  return [...set].map(show).join(",");
}
later(new Set<string | null>(["async"])).then((text) => console.log(text));
const record: Record<string, unknown> = { owners, tags };
console.log(JSON.stringify(record), Object.keys(record).join(","));
console.log(record);
