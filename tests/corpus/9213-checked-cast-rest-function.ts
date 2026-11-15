// A checked cast whose target has a TYPED-REST member (`(...parts: string[])`
// — the packed rest array) is inside the conversion's domain: the dynamic
// value's function is adapted per call, arguments and result checked against
// the target's signature, exactly like a fixed-arity member. Node erases the
// cast, so the calls read the same values.

function asDyn(value: unknown): unknown {
  return value;
}

const mod = asDyn({ join: (...parts: string[]) => parts.join("/") });
const path = mod as { join: (...rest: string[]) => string };
console.log(path.join("a", "b"), path.join("x"), path.join());

interface Args {
  label: string;
  rest: (...values: number[]) => number;
}
const boxed = asDyn({ label: "sum", rest: (...values: number[]) => values.reduce((a, b) => a + b, 0) });
const args = boxed as Args;
console.log(args.label, args.rest(1, 2, 3), args.rest());
