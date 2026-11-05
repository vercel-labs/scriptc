// A property name decided at RUNTIME (`{ [key]: value }`): Node evaluates
// the key where it stands, in source order, with the key and value
// expressions of each property interleaved. A record layout sorts its
// declared fields and keeps overflow entries apart, so it cannot hold such
// a key; the literal builds the checked-dynamic object the source order
// describes and its destination's conversion checks the values afterwards.
// TypeScript drops a union-keyed property from the literal's inferred type
// as soon as a spread joins the literal, while the evaluated object keeps
// it — the source order is the truth.

const PREFIX = "page";

function keyOf(name: string): string {
  return `${PREFIX}_${name}`;
}

// A page builder whose key is its argument, joined by a declared field and
// a conditional spread (the pi `list` / `_meta` shape).
function page<T>(items: T[], key: "red" | "blue"): unknown {
  const server = "srv-1";
  const busy = items.length > 1;
  return { server, [key]: items, ...(busy ? { next: 7 } : ({} as { next?: number })) };
}

console.log(JSON.stringify(page([{ id: "a" }], "red")));
console.log(JSON.stringify(page([{ id: "a" }, { id: "b" }], "blue")));
console.log(JSON.stringify(page([], "red")));

// Source and evaluation order: each property's key expression runs before
// its value expression, and both run where the property is written.
const trace: string[] = [];
function note(tag: string): string {
  trace.push(`k:${tag}`);
  return tag;
}
function value(tag: string): number {
  trace.push(`v:${tag}`);
  return tag.length;
}
const ordered: Record<string, number> = {
  [note("a")]: value("a"),
  fixed: 1,
  [note("b")]: value("b"),
};
console.log(JSON.stringify(ordered));
console.log(trace.join(","));

// A runtime key naming a record value, beside a second runtime key: both
// land in the index-signature record in source order.
const nested = { [keyOf("outer")]: { inner: 2, fixed: 1 }, [keyOf("after")]: 3 };
console.log(JSON.stringify(nested));

// Runtime keys written through an index signature, read back and probed
// with the same computed key.
type Kind = "read" | "write";

function tally(kinds: Kind[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const kind of kinds) {
    out[kind] = (out[kind] ?? 0) + 1;
  }
  return out;
}

const counts = tally(["read", "write", "read"]);
console.log(JSON.stringify(counts), Object.keys(counts).join(","));
for (const kind of ["read", "write", "other"] as const) {
  console.log(kind, kind in counts, counts[kind]);
}

// A runtime key whose value is a spread of another record: Node keeps the
// spread's keys in their own order after the key it stands on.
function withSpread(key: string, base: { a: number; b: number }): unknown {
  return { [key]: "here", ...base };
}
console.log(JSON.stringify(withSpread(keyOf("mid"), { a: 1, b: 2 })));

// A union-keyed literal that stays a plain record destination: the values
// check against the destination's fields.
type Sample = { kind: "ok"; n: number } | { kind: "err"; message: string };
function sample(key: "kind", ok: boolean): Sample {
  return { [key]: ok ? "ok" : "err", n: 1, message: "m" } as Sample;
}
console.log(JSON.stringify(sample("kind", true)));
