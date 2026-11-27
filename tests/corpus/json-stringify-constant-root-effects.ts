// A constant JSON.stringify root still evaluates its argument expressions, in
// source order: Node runs the root expression — a call, a comma operand, a
// typed constant — and the replacer and space expressions before it answers.
let calls = 0;
const n: null = null;
let u: undefined = undefined;
function f(): null {
  calls++;
  return null;
}
const shown = (v: string | undefined): string => (v === undefined ? "<undefined>" : v);
console.log("literal null", JSON.stringify(null), calls);
console.log("comma null", JSON.stringify((calls++, null)), calls);
console.log("typed null", JSON.stringify((calls++, n)), calls);
console.log("call null", JSON.stringify(f()), calls);
console.log("typed undefined", shown(JSON.stringify((calls++, u))), calls);
console.log("literal undefined", shown(JSON.stringify(undefined)), calls);
