// Arrays stored on the global object through a typed view are the same
// arrays every typed read returns: writes through one read (push, index
// assignment, sort) are visible through the next, as in Node.
type Store = typeof globalThis & { __exampleCache?: number[]; __exampleNames?: string[] };

function cache(): number[] {
  const g = globalThis as Store;
  g.__exampleCache ??= [1];
  return g.__exampleCache;
}

cache().push(2);
cache().push(3);
cache()[0] = 10;
console.log(cache().length, cache().join(","), cache() === cache());

const view = globalThis as Store;
view.__exampleNames = ["b", "a"];
const names = view.__exampleNames;
names.push("c");
names.sort();
console.log(view.__exampleNames.join(","), names === view.__exampleNames);

// the same array seen through an untyped read
const raw = (globalThis as unknown as Record<string, unknown>)["__exampleCache"];
console.log(Array.isArray(raw), JSON.stringify(raw), raw === cache());

// a literal of another element type stays its own value
const counts = globalThis as typeof globalThis & { __exampleCounts?: number[][] };
counts.__exampleCounts = [[1], [2, 3]];
counts.__exampleCounts[1]!.push(4);
console.log(JSON.stringify(counts.__exampleCounts));

// a parenthesized or `satisfies`-wrapped literal is kept the same way
type Wrapped = typeof globalThis & { __exampleWrapped?: number[]; __exampleSatisfied?: number[] };
function wrapped(): number[] {
  const g = globalThis as Wrapped;
  g.__exampleWrapped ??= ([5]);
  return g.__exampleWrapped;
}
function satisfied(): number[] {
  const g = globalThis as Wrapped;
  g.__exampleSatisfied ||= [7] satisfies number[];
  return g.__exampleSatisfied;
}
wrapped().push(6);
satisfied().push(8);
console.log(wrapped().join(","), wrapped() === wrapped(), satisfied().join(","), satisfied() === satisfied());
