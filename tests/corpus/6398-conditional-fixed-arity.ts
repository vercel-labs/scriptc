// Conditional types over function types with fixed `any` and `any[]`
// parameters, as a generic wrapper's specialization sees them: a function
// that needs more arguments than the pattern passes takes the false
// branch, including through a tuple rest parameter, and a positional
// `any[]` parameter matches only functions whose parameter there accepts
// an array.
type FirstResult<F> = F extends (a: any) => infer R ? R : "takes more";
type NoArgResult<F> = F extends () => infer R ? R : "takes some";
type ArrayResult<F> = F extends (items: any[]) => infer R ? R : "not array";

function label<F extends (...args: any) => any>(fn: F, value: FirstResult<F>): string {
  const local: FirstResult<F> = value;
  return `${fn.name}: ${typeof local} ${String(local)}`;
}

function labelNoArgs<F extends (...args: any) => any>(fn: F, value: NoArgResult<F>): string {
  const local: NoArgResult<F> = value;
  return `${fn.name}: ${typeof local} ${String(local)}`;
}

function labelArray<F extends (...args: any) => any>(fn: F, value: ArrayResult<F>): string {
  const local: ArrayResult<F> = value;
  return `${fn.name}: ${typeof local} ${String(local)}`;
}

function none(): boolean {
  return true;
}
function one(a: string): number {
  return a.length;
}
function two(a: string, b: string): number {
  return a.length + b.length;
}
function optional(a: string, b?: string): number {
  return a.length + (b?.length ?? 0);
}
function rest(a: string, ...more: string[]): number {
  return a.length + more.length;
}
function pair(...args: [string, number]): number {
  return args[0].length + args[1];
}
function count(items: string[]): number {
  return items.length;
}
function anything(value: unknown): string {
  return typeof value;
}

console.log(label(none, true));
console.log(label(one, 3));
console.log(label(two, "takes more"));
console.log(label(optional, 4));
console.log(label(rest, 5));
console.log(label(pair, "takes more"));
console.log(labelNoArgs(none, false));
console.log(labelNoArgs(one, "takes some"));
console.log(labelNoArgs(optional, "takes some"));
console.log(labelNoArgs(pair, "takes some"));
console.log(labelArray(none, true));
console.log(labelArray(one, "not array"));
console.log(labelArray(rest, "not array"));
console.log(labelArray(count, 7));
console.log(labelArray(anything, "object"));
console.log(labelArray(two, "not array"));
