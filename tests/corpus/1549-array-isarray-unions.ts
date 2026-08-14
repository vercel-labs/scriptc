// Array.isArray on UNION-typed values answers by the runtime tag: true iff
// the active arm is an array kind — the narrowing test tsc's control flow
// then builds on (the certs `string | readonly string[]` and tailscale
// `string[] | undefined` idioms).
function names(tlds: string | string[]): string {
  const configured: string[] = Array.isArray(tlds) ? tlds : [tlds];
  return configured.join(",");
}
console.log(names("localhost"));
console.log(names(["a.test", "b.test"]));
console.log(names([]));

// readonly arrays ride the same tag test (tsc's own narrowing answers
// `any[]` around an `arg is any[]` guard on readonly unions, so the
// branches read nothing here — the certs SNICallback idiom's shape).
function isList(tlds: string | readonly string[]): boolean {
  return Array.isArray(tlds);
}
console.log(isList(["x.test", "y.test"]));
console.log(isList("bare"));

function hasHttps(capabilities: string[] | undefined): boolean {
  if (Array.isArray(capabilities) && capabilities.some((c) => c === "https")) {
    return true;
  }
  return false;
}
console.log(hasHttps(undefined));
console.log(hasHttps(["ssh", "https"]));
console.log(hasHttps(["ssh"]));

// The negated spelling narrows the else way around.
function total(value: number | number[]): number {
  if (!Array.isArray(value)) return value;
  let sum = 0;
  for (const n of value) sum += n;
  return sum;
}
console.log(total(7));
console.log(total([1, 2, 3]));

// Zero array arms fold to constant false; a union of two array kinds
// answers true for both.
const scalar: string | number = "text" as string | number;
console.log(Array.isArray(scalar));
const mixed: string[] | number[] | undefined = [3, 4] as string[] | number[] | undefined;
console.log(Array.isArray(mixed));
const missing: string[] | number[] | undefined = undefined;
console.log(Array.isArray(missing));

// Fixed tuples use a positional record-shaped IR representation so each
// slot can keep its own type, but they are still JavaScript arrays. This is
// the Native SDK facade shape: an update returns either its model record or
// [model, command], then Array.isArray selects the tuple before indexing it.
interface TupleModel {
  n: number;
}

interface TupleCommand {
  op: string;
}

function tupleUpdate(model: TupleModel, effect: boolean): TupleModel | [TupleModel, TupleCommand] {
  if (!effect) return model;
  return [model, { op: "spawn" }];
}

function normalizeTuple(model: TupleModel, effect: boolean): [TupleModel, string] {
  const out = tupleUpdate(model, effect);
  if (Array.isArray(out)) return [out[0], out[1].op];
  return [out, "none"];
}

function isFixedTuple(value: [TupleModel, TupleCommand]): boolean {
  return Array.isArray(value);
}

const plainResult = normalizeTuple({ n: 7 }, false);
console.log(plainResult[0].n, plainResult[1]);
const tupleResult = normalizeTuple({ n: 9 }, true);
console.log(tupleResult[0].n, tupleResult[1]);
console.log(isFixedTuple([{ n: 11 }, { op: "direct" }]));
