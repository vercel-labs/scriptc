// A two-armed conditional spread after properties with effects: every
// earlier property must evaluate exactly once, in source order, before the
// condition. Node is the oracle: the nested literal's call runs once, and
// the plain field read sees the value it had before the later bump().
const log: string[] = [];
let calls = 0;
function tick(): number {
  calls += 1;
  log.push("tick");
  return calls;
}

const state = { n: 1 };
function bump(): number {
  state.n = 2;
  log.push("bump");
  return 0;
}

function nested(flag: boolean) {
  return { inner: { n: tick() }, ...(flag ? { a: 1 } : { b: 2 }) };
}

function ordered(flag: boolean) {
  return { first: state.n, second: bump(), ...(flag ? { a: 1 } : { b: 2 }) };
}

console.log(JSON.stringify(nested(true)), calls, log.join(","));
log.length = 0;
const seen = ordered(true);
console.log(JSON.stringify(seen), state.n, log.join(","));
