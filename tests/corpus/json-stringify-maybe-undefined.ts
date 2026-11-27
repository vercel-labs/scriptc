// JSON.stringify of values whose checker type may be undefined: Node
// answers undefined for a missing root (JSON.stringify(undefined) is not a
// string at all), the value's JSON otherwise, and a null root is the text
// "null". Roots: bare undefined, optional scalars, records, arrays, null
// arms, optional properties, array elements and record fields that hold an
// absent value, a class toJSON that answers undefined, and a class field
// whose recursive union admits undefined.
function out(label: string, f: () => string | undefined): void {
  const v = f();
  console.log(label, v === undefined ? "<undefined>" : v);
}

const strAbs: () => string | undefined = () => undefined;
const strPre: () => string | undefined = () => "x";
const numAbs: () => number | undefined = () => undefined;
const numPre: () => number | undefined = () => 3;
const recAbs: () => { a: number } | undefined = () => undefined;
const recPre: () => { a: number } | undefined = () => ({ a: 1 });
const arrAbs: () => number[] | undefined = () => undefined;
const arrPre: () => number[] | undefined = () => [1, 2];
const nulAbs: () => { a: number } | null = () => null;
const nulPre: () => { a: number } | null = () => ({ a: 1 });
const nuAbs: () => { a: number } | null | undefined = () => undefined;
const rec = (): { a?: string } => ({});

out("bare", () => JSON.stringify(undefined));
out("str abs", () => JSON.stringify(strAbs()));
out("str pre", () => JSON.stringify(strPre()));
out("num abs", () => JSON.stringify(numAbs()));
out("num pre", () => JSON.stringify(numPre()));
out("rec abs", () => JSON.stringify(recAbs()));
out("rec pre", () => JSON.stringify(recPre()));
out("arr abs", () => JSON.stringify(arrAbs()));
out("arr pre", () => JSON.stringify(arrPre()));
out("null abs", () => JSON.stringify(nulAbs()));
out("null pre", () => JSON.stringify(nulPre()));
out("null|undef abs", () => JSON.stringify(nuAbs()));
out("optional prop", () => JSON.stringify(rec().a));
out("array element", () => JSON.stringify([strAbs()]));
out("record field", () => JSON.stringify({ v: strAbs() }));
out("indent", () => JSON.stringify(recPre(), null, 2));
class C {
  toJSON(): undefined {
    return undefined;
  }
}
out("toJSON class", () => JSON.stringify(new C()));
const assigned: string | undefined = JSON.stringify(strAbs());
out("assigned", () => assigned);
out("comparison", () => String(JSON.stringify(strAbs()) === undefined));

type Sheet = string | number | boolean | null | undefined | Sheet[] | { [name: string]: Sheet };
class Notebook {
  latest: Sheet = undefined;
  add(page: Sheet): void {
    this.latest = page;
  }
}
const notebook = new Notebook();
notebook.add({ k: [1, undefined] });
out("recursive union", () => JSON.stringify(notebook.latest));
