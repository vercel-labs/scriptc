// A callable that declares its own `apply` dispatches to that table entry,
// not to Function.prototype.apply, for every argument form that has a value
// (an array literal, a tuple, a plain array). The statically resolved
// forwarding form refuses by name instead (tests/diagnostics).
interface Applier {
  (n: number): number;
  apply(thisArg: unknown, args: number[]): number;
}

const a = ((n: number): number => n + 1) as Applier;
a.apply = (_thisArg: unknown, args: number[]): number => args.length * 100 + args[0]!;

const pair: [number, number] = [1, 2];
const plain: number[] = [5, 6];

console.log("array", a.apply(null, [3, 4]));
console.log("tuple", a.apply(null, pair));
console.log("plain", a.apply(null, plain));

// The table entry can be replaced; the call form follows it.
a.apply = (): number => 9;
console.log("replaced", a.apply(null, [7]));

// A plain call never reads the table.
console.log("call", a(1), typeof a, Object.keys(a).join(","));
