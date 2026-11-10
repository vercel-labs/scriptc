// The es2025-lib surface WITHOUT a lowering fences by name: Atomics.waitAsync,
// Iterator.from over objects with their own next method, and the unlowered
// forms of the implemented statics (Promise.try with fewer arguments than
// parameters, groupBy's literal-union keys, a set-like non-Set argument).

// Atomics.waitAsync.
const ia = new Int32Array(4);
const waited = Atomics.waitAsync(ia, 0, 0, 1);

// Iterator.from over an object with its own next method.
const it = Iterator.from({ next: (): IteratorResult<number> => ({ value: 1, done: false }) });

// Promise.try with fewer arguments than the callback's parameters.
const tried = Promise.try((a: number, b?: number) => a + (b ?? 0), 1);

// Object.groupBy at a literal-union key type (a fixed-field record).
const grouped = Object.groupBy([1, 2, 3], (n) => (n % 2 === 0 ? "even" : "odd"));

// A set-like argument that is neither a Set nor a Map.
const s = new Set([1, 2]);
const like = { size: 1, has: (x: number) => x === 1, keys: () => [1].values() };
const u = s.union(like);
