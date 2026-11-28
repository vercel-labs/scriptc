// An array literal as a direct prefix value of a two-armed conditional
// spread: the elements must evaluate exactly once, at their own position.
// Node is the oracle.
let calls = 0;
function tick(): number {
  calls += 1;
  return calls;
}

function build(flag: boolean) {
  const held = 7;
  return { values: [tick(), tick()], held, ...(flag ? { a: 1 } : { b: 2 }) };
}

console.log(JSON.stringify(build(true)), calls);
const again = build(false);
console.log(JSON.stringify(again), calls);

// A `new` expression and a tagged template as prefix values too.
class Holder {
  n: number;
  constructor(n: number) {
    this.n = n;
  }
}
function tag(parts: TemplateStringsArray, value: number): string {
  calls += 1;
  return `${parts[0]}${value}`;
}
function mixed(flag: boolean) {
  return {
    made: new Holder(tick()),
    stamped: tag`v=${tick()}`,
    ...(flag ? { a: 1 } : { b: 2 }),
  };
}
console.log(JSON.stringify(mixed(true)), calls);
