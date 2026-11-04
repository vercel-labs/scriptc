// Sets and Maps keyed by functions: a function reached through bindings of
// other function types is one key, as `===` finds it one function.

const inc = (x: number): number => x + 1;
const wide: (x: number, y?: number) => number = inc;
const other: (x: number, y?: number) => number = inc;
const double = (x: number, y?: number): number => x * 2 + (y ?? 0);
console.log(wide === other, wide === double);

// A Set of one function type.
const handlers = new Set<(x: number, y?: number) => number>();
handlers.add(wide);
handlers.add(other);
handlers.add(double);
console.log(handlers.size, handlers.has(other), handlers.has(wide));
for (const handler of handlers) console.log(handler(3));
handlers.delete(other);
console.log(handlers.size, handlers.has(wide));

// A Map from functions to their names.
const names = new Map<(x: number, y?: number) => number, string>();
names.set(wide, "wide");
names.set(other, "other");
names.set(double, "double");
console.log(names.size, names.get(wide), names.get(other), names.get(double));
console.log([...names.values()].join(","));

// A function or undefined as a key.
const optional = new Map<((x: number, y?: number) => number) | undefined, number>();
optional.set(wide, 1);
optional.set(undefined, 2);
optional.set(other, 3);
console.log(optional.size, optional.get(wide), optional.get(undefined));
for (const [key, value] of optional) console.log(key === undefined ? "undefined" : key(1), value);


// A function, null or undefined as a key.
const nullable = new Map<((x: number, y?: number) => number) | null | undefined, string>();
nullable.set(null, "null");
nullable.set(wide, "wide");
nullable.set(undefined, "undefined");
nullable.set(other, "other");
console.log(nullable.size, nullable.get(null), nullable.get(wide), nullable.get(undefined));
