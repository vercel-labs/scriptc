// `"k" in x` over a value whose type is a union with a record arm that does
// not declare `k`: the object may still have it, because a value of a wider
// type flowed into the narrower one. The answer is the object's own key in
// every spelling, also where the test sits in an expression and the value
// keeps its union type (`x !== undefined && "k" in x`).
interface Reply {
  handled?: boolean;
  focus?: boolean;
}
interface Tagged extends Reply {
  handled: true;
  tag: { label: string; weight: number };
}
function produce(n: number): Reply | undefined {
  if (n === 0) return undefined;
  if (n > 5) {
    const tagged: Tagged = { handled: true, focus: n > 7, tag: { label: "t" + n, weight: n } };
    return tagged;
  }
  return { handled: n > 2 };
}
function conjunction(n: number): string {
  const result = produce(n);
  const has = result !== undefined && "tag" in result;
  return String(has);
}
function statement(n: number): string {
  const result = produce(n);
  if (result === undefined) return "undefined";
  return "tag" in result ? "in" : "out";
}
function conditional(n: number): string {
  const result = produce(n);
  return result !== undefined && "tag" in result ? "in" : "out";
}
function negated(n: number): string {
  const result = produce(n);
  return result === undefined || !("tag" in result) ? "out" : "in";
}
function declared(n: number): string {
  const result = produce(n);
  return result !== undefined && "handled" in result ? "in" : "out";
}
const inputs = [0, 3, 8];
console.log(inputs.map(conjunction).join());
console.log(inputs.map(statement).join());
console.log(inputs.map(conditional).join());
console.log(inputs.map(negated).join());
console.log(inputs.map(declared).join());

// Two record arms. A key neither declares is the value's to answer; a key
// one arm declares selects that arm.
interface Plain {
  kind: "plain";
  size: number;
}
interface Marked {
  kind: "marked";
  mark: string;
}
interface Extra extends Plain {
  note: string;
}
function pick(n: number): Plain | Marked {
  if (n === 0) return { kind: "marked", mark: "m" };
  if (n === 1) return { kind: "plain", size: 1 };
  const extra: Extra = { kind: "plain", size: n, note: "n" + n };
  return extra;
}
console.log([0, 1, 2].map((n) => ("note" in pick(n) ? "note" : "none")).join());
console.log([0, 1, 2].map((n) => ("mark" in pick(n) ? "mark" : "none")).join());
