// An inexact type predicate: `isSpecial` returns false for an `A` whose `x`
// is small, so the else branch of `if (isSpecial(v))` can still receive an
// `A`. The checker narrows that branch to `B | C`; reading `kind` there, a
// field every arm declares, must read the stored value's field rather than
// narrow the value past the `A` arm the negation stranded.
type A = { kind: "a"; x: number };
type B = { kind: "b"; y: number };
type C = { kind: "c"; z: number };
type Kind = A | B | C;

function isSpecial(v: Kind): v is A {
  return v.kind === "a" && v.x > 100;
}

function describeKind(v: Kind): string {
  if (isSpecial(v)) return `special ${v.x}`;
  return v.kind;
}

const values: Kind[] = [
  { kind: "a", x: 1 },
  { kind: "a", x: 200 },
  { kind: "b", y: 2 },
  { kind: "c", z: 3 },
];
for (const value of values) console.log(describeKind(value));

// The same read when the predicate names a union of arms: the else branch
// is narrowed to `R | S`, and the stranded `P` (which the predicate returned
// false for) still declares `label`. `Q` does not declare it, so it keeps
// its trap; the arms that do answer the read are kept.
type P = { kind: "p"; px: number; label: string };
type Q = { kind: "q"; qy: number };
type R = { kind: "r"; rz: number; label: string };
type S = { kind: "s"; sw: number; label: string };
type Item = P | Q | R | S;

function isPOrQ(v: Item): v is P | Q {
  return (v.kind === "p" && v.px > 100) || v.kind === "q";
}

function labelOf(v: Item): string {
  if (isPOrQ(v)) return "p or q";
  return v.label;
}

const items: Item[] = [
  { kind: "p", px: 1, label: "p-small" },
  { kind: "r", rz: 2, label: "r" },
  { kind: "s", sw: 3, label: "s" },
];
for (const item of items) console.log(labelOf(item));
