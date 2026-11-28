// A property with effects before a two-armed conditional spread: the arms
// give the literal a union destination, so it is one record per arm. The
// effect must run once per evaluation, at its own position, before the
// condition. Node is the oracle.
const log: string[] = [];
let counter = 0;
function next(label: string): number {
  log.push(label);
  return ++counter;
}

function build(flag: boolean) {
  return { id: next("id"), ...(flag ? { a: 1 } : { b: "2" }) };
}

for (const flag of [true, false]) {
  const value = build(flag);
  console.log(JSON.stringify(value), Object.keys(value).join(","), log.join(","), counter);
}
