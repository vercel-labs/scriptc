// A conditional spread whose arms both carry keys: `{ k, ...(c ? { a } :
// { b }) }`. The literal is one record per arm, so the keys present, their
// order, and what Object.keys, `in` and JSON report must be the taken arm's
// alone. The test runs once, then only the taken arm's values, at the
// spread's own position.
const log: string[] = [];
function note<T>(label: string, value: T): T {
  log.push(label);
  return value;
}
function wrap(v: unknown): unknown {
  return { wrapped: v };
}
function keysOf(v: Record<string, unknown>): string {
  return Object.keys(v).join(",");
}

// Unknown-typed values, one of which can be undefined: the key stays.
function unknownArms(flag: boolean, v: unknown) {
  return { name: "n", ...(flag ? { alpha: v } : { beta: wrap(v) }) };
}

// The same key in both arms with different value types, and a later key.
function sameKey(flag: boolean) {
  return { id: 1, ...(flag ? { v: 1 } : { v: "s" }), tail: true };
}

// One arm's keys contain the other's; arm and later values have effects.
function subset(flag: boolean) {
  return {
    id: 1,
    ...(flag ? { a: note("a", "a"), b: note("b", "b") } : { a: note("a2", "a2") }),
    z: note("z", "z"),
  };
}

// An arm overwrites an earlier key, which keeps its first position.
function overwrite(flag: boolean) {
  return { id: 1, kind: "base", ...(flag ? { x: 1 } : { kind: "b", y: 2 }) };
}

// Arms that are record values rather than literals.
function recordArms(flag: boolean, a: { p: number }, b: { q: string }) {
  return { id: 1, ...(flag ? a : b) };
}

// A test with effects after constant properties.
function effectfulTest(flag: boolean) {
  return { id: 1, ...(note("test", flag) ? { a: note("a", 1) } : { b: note("b", "2") }) };
}

// A declared discriminated union as the destination.
type Message =
  | { kind: "ok"; value: number; id: number }
  | { kind: "err"; reason: string; id: number };
function declared(flag: boolean): Message {
  return {
    id: 7,
    ...(flag ? { kind: "ok" as const, value: 1 } : { kind: "err" as const, reason: "r" }),
  };
}

// Inside an array callback whose result lands in an unknown-valued record.
interface Item {
  name: string;
  note: string;
  size: number;
}
function describe(
  items: Item[],
  flag = false,
): { entries: Record<string, unknown>[] }[] | undefined {
  if (items.length === 0) return undefined;
  return [
    {
      entries: items.map((item) => {
        const extra = { n: item.size };
        return {
          name: item.name,
          note: item.note,
          ...(flag ? { alpha: wrap(extra as unknown) } : { beta: extra }),
        };
      }),
    },
  ];
}

const items: Item[] = [
  { name: "a", note: "first", size: 1 },
  { name: "b", note: "second", size: 2 },
];
for (const flag of [true, false]) {
  const u = unknownArms(flag, undefined);
  console.log(JSON.stringify(u), keysOf(u), "alpha" in u, "beta" in u);
  const u2 = unknownArms(flag, 5);
  console.log(JSON.stringify(u2), keysOf(u2));

  const s = sameKey(flag);
  console.log(JSON.stringify(s), keysOf(s), typeof s.v);

  log.length = 0;
  const t = subset(flag);
  console.log(JSON.stringify(t), keysOf(t), "b" in t, log.join(">"));

  const o = overwrite(flag);
  console.log(JSON.stringify(o), keysOf(o));

  const r = recordArms(flag, { p: 1 }, { q: "q" });
  console.log(JSON.stringify(r), keysOf(r));

  log.length = 0;
  const e = effectfulTest(flag);
  console.log(JSON.stringify(e), keysOf(e), log.join(">"));

  const d = declared(flag);
  console.log(JSON.stringify(d), d.kind === "ok" ? d.value : d.reason);

  const described = describe(items, flag);
  console.log(JSON.stringify(described));
  for (const entry of described![0]!.entries) console.log(keysOf(entry), "alpha" in entry);
}
console.log(describe([]) === undefined);
