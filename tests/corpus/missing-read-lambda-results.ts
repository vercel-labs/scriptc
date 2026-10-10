// A missing read (an out-of-range typed-array or array read the checker
// types as `number`) defaulted with `??` or `||` to a string, or returned
// as is, gives a lambda a result its inferred return type does not spell:
// TypeScript types `read ?? "text"` and `() => xs[i]` as number. The
// closure returns the runtime value, through bindings, callbacks taking
// `unknown`, calls of the binding, and the enclosing function's return.
const base: number = process.argv.length;
const chars = new Uint16Array(4);
chars[0] = 108;
const nums: number[] = [7];
const far = base + 100;
const a = chars[far];
const c0 = chars[0];

// The scanbox probe table: every arrow is typed `() => number` by
// inference and stored in a `() => unknown` slot.
const probes: [string, () => unknown][] = [
  ["plus", () => a + 1],
  ["or", () => a | 0],
  ["max", () => Math.max(a, 1)],
  ["fcc", () => JSON.stringify(String.fromCharCode(c0, a))],
  ["and", () => c0 && 5],
  ["or2", () => chars[far] || 7],
  ["nullish", () => a ?? "dflt"],
  ["nullish present", () => c0 ?? "dflt"],
  ["tern", () => (a ? "yes" : "no")],
  ["bang", () => !a],
  ["concat", () => a + "s"],
  ["missing", () => nums[far]],
];
for (const [name, f] of probes) {
  try {
    console.log(name, f());
  } catch (e) {
    console.log(name, "threw", (e as Error).message);
  }
}

function take(f: () => unknown): unknown {
  return f();
}
console.log("take nullish", take(() => a ?? "d1"));
console.log("take missing", take(() => nums[far]));

const bound = () => a ?? "d2";
console.log("bound", bound());
const block = () => {
  return a ?? "d3";
};
console.log("block", block());
const expression = function () {
  return a || "d4";
};
console.log("expression", expression());
const read = () => nums[far];
console.log("read", read(), read() === undefined);

function viaBinding(i: number): number {
  const get = () => nums[i];
  return get();
}
console.log("via binding", viaBinding(far), viaBinding(0));

function declared() {
  return a ?? "d5";
}
console.log("declared", declared());

class Lexer {
  peek(i: number) {
    return chars[i] ?? "eof";
  }
}
console.log("method", new Lexer().peek(far), new Lexer().peek(0));
