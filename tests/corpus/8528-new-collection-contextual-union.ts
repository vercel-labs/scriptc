// `new Map()` (no type arguments) in a contextual slot whose type is a
// union: `Map<K, V> | undefined`, `ReadonlyMap<K, V> | null`. A Map value
// can only inhabit the map arm, so the construction adopts that layout
// instead of the checker's bare Map<unknown, unknown>.

function lookup(handlers: Map<string, number> | undefined, key: string): string {
  if (handlers === undefined) return "absent";
  const found = handlers.get(key);
  return found === undefined ? "missing" : String(found);
}

const counts: Map<string, number> | undefined = new Map();
if (counts !== undefined) {
  counts.set("a", 1);
  counts.set("b", counts.size + 2);
  console.log(counts.size, counts.get("a"), counts.get("b"));
}
console.log(lookup(counts, "a"), lookup(counts, "z"), lookup(undefined, "a"));
console.log(counts instanceof Map);

// A nullable annotation takes the same arm.
const nullable: Map<string, number> | null = new Map();
console.log(nullable !== null, nullable instanceof Map);

// A readonly view announces no writes; the value is still a real Map.
const readonlyView: ReadonlyMap<string, number> | undefined = new Map();
if (readonlyView !== undefined) {
  console.log(readonlyView.size, readonlyView.get("missing") === undefined);
}

// The contextual type of an optional record field is the same union.
type Registry = {
  handlers?: Map<string, number>;
  names?: Set<string>;
};

function createRegistry(): Registry {
  return { handlers: new Map(), names: new Set() };
}

const registry = createRegistry();
if (registry.handlers !== undefined) {
  registry.handlers.set("on", 7);
  console.log(registry.handlers.size, registry.handlers.get("on"));
}
if (registry.names !== undefined) {
  registry.names.add("first");
  console.log(registry.names.size, registry.names.has("first"));
}

// A parameter slot infers the same way for Map and Set.
function describe(map: Map<string, number> | undefined, set: Set<string> | undefined): string {
  return `${map === undefined ? "-" : map.size}/${set === undefined ? "-" : set.size}`;
}
console.log(describe(new Map(), new Set()), describe(undefined, undefined));

// Iteration and JSON-free surfaces keep the element types.
const entries = new Map([["x", 1], ["y", 2]] as [string, number][]);
console.log([...entries.keys()].join(","), [...entries.values()].join(","));
