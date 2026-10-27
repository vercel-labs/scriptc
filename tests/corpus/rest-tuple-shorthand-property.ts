// A rest parameter typed as a fixed tuple, read through a shorthand property
// (`{ xs }`), directly or through a const alias, is the tuple of the call's
// arguments.

function wrap(...xs: [number]) {
  return { xs };
}
function pair(...args: [string, number]) {
  const kept = args;
  return { kept, size: args.length };
}
function add(a: number, b: number): number {
  return a + b;
}
function forward(...args: [number, number]): number {
  return add(...args);
}

const w = wrap(1);
console.log(w.xs[0], w.xs.length, JSON.stringify(w));
const p = pair("a", 2);
console.log(p.kept[0], p.kept[1], p.size, JSON.stringify(p));
console.log(forward(3, 4));
