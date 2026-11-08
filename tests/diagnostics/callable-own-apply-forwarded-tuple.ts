// A callable's own `apply` is the callee of `f.apply(...)`, so the
// statically resolved forwarding form (a fixed tuple reaching a direct call
// of the function body) cannot serve it: the tuple has no value form to hand
// the own member. Named refusal instead of the wrong callee.
interface Applier {
  (n: number): number;
  apply(thisArg: unknown, args: number[]): number;
}

const a = ((n: number): number => n + 1) as Applier;
a.apply = (): number => 777;

function forward(...nums: [number]): number {
  return a.apply(null, nums);
}

console.log(forward(1));
