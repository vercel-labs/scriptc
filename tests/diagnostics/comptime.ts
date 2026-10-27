// tsc-clean misuses of comptime: the callback must be an inline function
// literal with no references to outer bindings, it must not throw or time
// out, and its result must bake as a finite literal of the expected type.
const limit = 4;
const captured = comptime(() => limit * 2);

function make(): number {
  return 3;
}
const viaRef = comptime(make);

const thrown = comptime((): number => {
  throw "boom at compile time";
});

const nan = comptime(() => 0 / 0);

const nested = comptime(() => comptime(() => 1));

const eventually = comptime(async () => 1);

const lied = comptime(() => 1 as unknown as string);

// A record type reachable from its own fields has no literal form.
interface Chain {
  value: number;
  next: Chain | null;
}
const chain: Chain = comptime(() => ({ value: 1, next: null }) as Chain);

// A union reachable from itself through an array has no literal form either.
type Tree = number | Tree[];
const tree: Tree = comptime((): Tree => [1, [2, [3]]]);
