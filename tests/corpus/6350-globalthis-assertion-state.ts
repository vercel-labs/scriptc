// Process-global state on the global object through a type assertion:
// every assertion of globalThis denotes the global object itself, so a
// write through one view is visible through every other view and through
// a view bound before the write.
const KEY = Symbol.for("example.state");
interface State {
  n: number;
  log: string[];
}
type Holder = { [KEY]?: State; label?: string };

const early = globalThis as Holder;

function get(): State | undefined {
  return early[KEY];
}

early[KEY] = { n: 1, log: [] };
console.log(get()?.n, (globalThis as Holder)[KEY]?.n);

function touch(entry: string): void {
  const view = globalThis as Holder;
  const state = view[KEY] ?? (view[KEY] = { n: 0, log: [] });
  state.n++;
  state.log.push(entry);
}
touch("a");
touch("b");
console.log(early[KEY]?.n, early[KEY]?.log.join(","), get() === early[KEY]);

// string-keyed members of the same object
(globalThis as Holder).label = "ready";
console.log(early.label, (globalThis as unknown as { label?: string }).label);

// ??= initializes once; delete removes the member for every view
const COUNTER = Symbol.for("example.counter");
type Counters = { [COUNTER]?: { hits: number } };
(globalThis as Counters)[COUNTER] ??= { hits: 0 };
(globalThis as Counters)[COUNTER] ??= { hits: 100 };
const counters = globalThis as Counters;
counters[COUNTER]!.hits += 2;
console.log((globalThis as Counters)[COUNTER]?.hits, COUNTER in globalThis);
delete counters[COUNTER];
console.log((globalThis as Counters)[COUNTER], COUNTER in globalThis);

// an index-signature view
const dict = globalThis as unknown as Record<string, number | undefined>;
dict.exampleTotal = 1;
dict["exampleTotal"] = (dict["exampleTotal"] ?? 0) + 1;
console.log((globalThis as unknown as { exampleTotal?: number }).exampleTotal);
