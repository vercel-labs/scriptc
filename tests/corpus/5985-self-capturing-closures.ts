// Closures that call themselves through the binding they are stored in:
// const arrows, function expressions, closures made in loops, closures that
// also hand themselves to nested callbacks, and a binding that is later
// rebound (its closure must see the new value). Each read of the binding
// inside the body is the same function object the binding holds. The
// sanitized lane's RC audit fails if any of these closures leaks or is
// freed while reachable.

const fact = (n: number): number => (n <= 1 ? 1 : n * fact(n - 1));
console.log(fact(10));

const pick = (n: number): (() => number) | null => (n === 0 ? null : () => n);
const identity = (depth: number): unknown => (depth === 0 ? identity : identity(depth - 1));
console.log(identity(3) === identity, pick(0) === null, pick(2)!());

const fib = function (n: number): number {
  return n < 2 ? n : fib(n - 1) + fib(n - 2);
};
console.log(fib(15));

const outerName = function innerName(n: number): number {
  return n <= 0 ? 0 : 1 + outerName(n - 1) + innerName(0);
};
console.log(outerName(5));

// One closure per iteration, each recursing into itself and reading its
// own iteration's value.
const perIteration: ((n: number) => number)[] = [];
for (let i = 0; i < 4; i++) {
  const step = (n: number): number => (n === 0 ? i : step(n - 1) + 10);
  perIteration.push(step);
}
console.log(perIteration.map((f) => f(2)).join(" "));
console.log(perIteration[0] === perIteration[1], perIteration[2] === perIteration[2]);

// The closure also passes itself to nested callbacks.
interface Tree {
  value: number;
  kids: Tree[];
}
const leaf = (value: number): Tree => ({ value, kids: [] });
const tree: Tree = {
  value: 1,
  kids: [{ value: 2, kids: [leaf(3), leaf(4)] }, leaf(5)],
};
const sum = (node: Tree): number => node.value + node.kids.map((kid) => sum(kid)).reduce((a, b) => a + b, 0);
console.log(sum(tree));
const visited: number[] = [];
const walk = (node: Tree): void => {
  visited.push(node.value);
  node.kids.forEach(walk);
};
walk(tree);
console.log(visited.join(","));

// Captured state next to the self reference.
function counterTo(limit: number): () => number {
  let calls = 0;
  const tick = (): number => {
    calls++;
    return calls < limit ? tick() : calls;
  };
  return tick;
}
const tick = counterTo(5);
console.log(tick(), tick());

// A rebound binding: the first closure calls whatever the binding holds now.
let rebound = (n: number): number => (n <= 0 ? 0 : 1 + rebound(n - 1));
const first = rebound;
console.log(first(3));
rebound = (n: number): number => n * 100;
console.log(first(3), rebound(3));

// Mutual recursion keeps both bindings live.
const isEven = (n: number): boolean => (n === 0 ? true : isOdd(n - 1));
const isOdd = (n: number): boolean => (n === 0 ? false : isEven(n - 1));
console.log(isEven(10), isOdd(7), isEven(3));

// Identity as a map key from inside the body.
const seen = new Map<unknown, number>();
const keyed = (n: number): number => {
  seen.set(keyed, (seen.get(keyed) ?? 0) + 1);
  return n === 0 ? seen.size : keyed(n - 1);
};
console.log(keyed(4), seen.get(keyed));

// An object that holds a closure capturing the object (a real cycle).
class Widget {
  label: string;
  onChange: (() => string) | null = null;
  constructor(label: string) {
    this.label = label;
  }
}
function widgets(count: number): number {
  let total = 0;
  for (let i = 0; i < count; i++) {
    const widget = new Widget(`w${i}`);
    const describe = (depth: number): string => (depth === 0 ? widget.label : describe(depth - 1));
    widget.onChange = () => describe(2);
    total += widget.onChange().length;
  }
  return total;
}
console.log(widgets(1000));

// Many short-lived recursive closures.
let checksum = 0;
for (let round = 0; round < 20000; round++) {
  const down = (n: number): number => (n === 0 ? round % 7 : down(n - 1));
  checksum += down(3);
}
console.log(checksum);

// Generators and async functions that name themselves.
const countdown = function* (n: number): Generator<number> {
  if (n < 0) return;
  yield n;
  yield* countdown(n - 1);
};
console.log([...countdown(3)].join(""));
const later = async (n: number): Promise<number> => (n === 0 ? 0 : 1 + (await later(n - 1)));
later(3).then((value) => console.log("async", value));
