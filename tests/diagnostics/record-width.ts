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

// A builtin handle such as process.stdout projects into a record of
// METHODS only: each one calls the handle's member. A data member would be
// a copy of the stream's state, so a record that declares one stays
// outside the projection.
type TtySink = { write(text: string): boolean; isTTY: boolean };
const tty: TtySink = process.stdout;
console.log(tty.isTTY);

// A variadic method stays outside the projection too: the projection calls
// the member through the dynamic tier, which has no spread form.
type RestSink = { write(text: string, ...rest: any[]): boolean };
const restSink: RestSink = process.stdout;
console.log(restSink.write("one", "two"));

import { Writable } from "node:stream";

// An instance of a runtime stream class is not a builtin handle and keeps
// SC2002; an object literal that wraps it fills a record of methods.
type LineSink = { write(line: string): boolean };
const lines: LineSink = new Writable({
  write(_chunk, _encoding, callback) {
    callback();
  },
});
lines.write("one\n");
