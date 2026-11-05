// SC2002: the RESIDUE of the width-copy family — record shapes that
// neither match exactly nor width-coerce. Each fence names the first
// blocking rule. (The width copies themselves — field-subset narrowing,
// hybrid captures, per-field lifts — are differential corpus.)

// An index-signature source cannot complete an absent optional field:
// the overflow could hold the key at runtime, and a completed undefined
// would drop that value.
type Loose = { [k: string]: number };
type PickedA = { a?: number };
const loose: Loose = { a: 1 };
const picked: PickedA = loose;
console.log(picked);

// A method field whose parameter shapes relate only BIVARIANTLY: the field
// lifts as a checked adapter, so only the console.log below refuses (a
// function value has no inspect lowering).
type SrcM = { m(x: { a: number }): void; extra: number };
type DstM = { m(x: { a: number; b: number }): void };
const srcM: SrcM = {
  m: (x) => {
    console.log(x.a);
  },
  extra: 1,
};
const dstM: DstM = srcM;
console.log(dstM);

// A source field that cannot enter the target's value slot (a Map has no
// dyn conversion into an 'unknown' signature slot).
type WithMap = { m: Map<string, number>; n: number };
const withMap: WithMap = { m: new Map(), n: 1 };
const bag: Record<string, unknown> = withMap;
console.log(bag);

// A declared target field that cannot take a runtime key collision from
// the signature slot (its type is narrower than the slot's).
type Odd = { a?: boolean; [k: string]: boolean | string | undefined };
const plain = { b: "hi" };
const odd: Odd = plain;
console.log(odd);
