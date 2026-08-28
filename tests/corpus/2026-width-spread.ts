// Width subtyping in SPREAD clothing: `{ ...wider }` building a narrower
// literal drops the extra fields and lifts the rest per field — the same
// copy-reshape rule as slot flows (SEMANTICS.md 36; Node's object would
// keep the extra keys, so reads-after-narrow only).
type A = { a: string; b: string };
const extra1 = { a: "a", b: "b", extra: "extra" };
const a1: A = { ...extra1 };
console.log(a1.a, a1.b);

// A spread field lifting into a union-typed target slot.
type B = { x: number | undefined; y: string };
const src = { x: 3, y: "s" };
const b1: B = { ...src };
const bx = b1.x;
if (bx !== undefined) console.log(bx, b1.y);

// A spread field whose own record narrows (nested width inside spread).
type C = { inner: { keep: string } };
const wide = { inner: { keep: "k", drop: 1 }, junk: true };
const c1: C = { ...wide };
console.log(c1.inner.keep);

// Later explicit properties still override the spread (last-write-wins).
const a2: A = { ...extra1, b: "override" };
console.log(a2.a, a2.b);

// A shape-changing static cast is erased in IR. The same-shape clone
// optimization must inspect that lowered value and decline to this width
// copy instead of cloning it as the asserted narrower shape.
const a3: A = { ...(extra1 as A), b: "cast override" };
console.log(a3.a, a3.b);

// The optional-source merge idiom keeps its present-test semantics next
// to the new lifts.
type Opts = { mode?: string };
const defaults = { mode: "default" };
function build(overrides: Opts | undefined): { mode: string } {
  return { ...defaults, ...overrides };
}
console.log(build({ mode: "set" }).mode, build(undefined).mode, build({}).mode);
