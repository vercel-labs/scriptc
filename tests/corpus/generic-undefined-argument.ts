// A generic call with a literal `undefined` argument binds T = undefined;
// the parameter holds undefined like a declared `v: undefined` parameter.
function kind<T>(v: T): string {
  return typeof v;
}
console.log(kind(undefined), kind(null), kind(1), kind("s"));
function same<T>(a: T, b: T): boolean {
  return a === b;
}
console.log(same(undefined, undefined));
function wrap<T>(v: T): { v: T } {
  return { v };
}
const w = wrap(undefined);
console.log(JSON.stringify(w), w.v === undefined, "v" in w);
function describe<T>(label: string, v: T): string {
  return `${label}=${String(v)}`;
}
console.log(describe("u", undefined));
