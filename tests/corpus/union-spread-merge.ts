// A spread merge over union-typed sources whose destination union has no
// single arm for the result: `{ ...base, ...override }` can carry fields from
// several arms at once, and Node keeps them all. Where the per-arm
// distribution cannot pick one arm (see union-spread-distribution.ts), the
// merge builds the object Node builds — a checked-dynamic copy that writes
// keys in source order and validates the value at its typed slots.
// JSON pins key order, last-writer-wins and the kept keys; the identity check
// shows nested values are copied by reference; the typed consumer and the
// post-merge write exercise the checked conversion.

interface OpenAiCompat {
  supportsStore?: boolean;
}

interface AnthropicCompat {
  supportsLongCacheRetention?: boolean;
}

type Compat = OpenAiCompat | AnthropicCompat;

// 1. The provider-composer merge: every arm is all-optional, so no arm can
// represent the union of both key sets. The keys land in source order.
function mergeCompat(base: Compat | undefined, override: Compat | undefined): Compat | undefined {
  if (!override) return base;
  return { ...base, ...override } as NonNullable<Compat>;
}

const merged = mergeCompat({ supportsStore: true }, { supportsLongCacheRetention: true });
if (merged !== undefined) console.log("merged", JSON.stringify(merged));
const kept = mergeCompat({ supportsStore: true }, undefined);
if (kept !== undefined) console.log("no-override", JSON.stringify(kept));
const filled = mergeCompat(undefined, { supportsLongCacheRetention: true });
if (filled !== undefined) console.log("no-base", JSON.stringify(filled));

// 2. Overlapping keys: the later source wins the value, the earlier source
// keeps the key's position.
interface Left {
  first?: string;
  shared?: string;
}
interface Right {
  shared?: string;
  second?: string;
}
type Side = Left | Right;
function overlap(base: Side, override: Side): Side {
  return { ...base, ...override } as Side;
}
console.log(
  "overlap",
  JSON.stringify(overlap({ first: "f", shared: "from-base" }, { shared: "from-override", second: "s" })),
);

// 3. Nested values are copied by reference, not deep-copied.
interface Inner {
  v: number;
}
interface XArm {
  kind: "x";
  inner: Inner;
  x?: number;
}
interface YArm {
  kind: "y";
  inner: Inner;
  y?: number;
}
type XY = XArm | YArm;
const inner: Inner = { v: 9 };
const nested = { ...({ kind: "x", inner: { v: 1 }, x: 2 } as XY), ...({ kind: "y", inner, y: 3 } as XY) } as XY;
if (nested.kind === "y") console.log("nested", JSON.stringify(nested), nested.inner.v, nested.inner === inner);

// 4. A typed consumer accepts the merged value; the checked conversion at the
// parameter is what validates it.
function describe(compat: Compat): string {
  return JSON.stringify(compat);
}
if (merged !== undefined) console.log("describe", describe(merged));
console.log("describe-single", describe({ supportsStore: false }));

// 5. The merge snapshots its sources: a later write to a source is not seen.
const source: OpenAiCompat = { supportsStore: true };
const snapshot = mergeCompat(source, { supportsLongCacheRetention: true });
source.supportsStore = false;
if (snapshot !== undefined) console.log("snapshot", JSON.stringify(snapshot), JSON.stringify(source));

// 6. A merge with an explicit field after the spreads.
function withExtra(base: Compat, override: Compat): Compat {
  return { ...base, ...override, supportsStore: true } as NonNullable<Compat>;
}
console.log("extra", JSON.stringify(withExtra({ supportsStore: false }, { supportsLongCacheRetention: true })));
