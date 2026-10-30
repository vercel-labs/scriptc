// `for (const x of registry.get(key) ?? [])`: the receiver's type is the
// iterable beside `never[]` — the array literal's type, whose only value is
// the empty array, so that arm runs zero iterations.
function setLength(registry: Map<string, Set<string>>, key: string): number {
  let total = 0;
  for (const name of registry.get(key) ?? []) total += name.length;
  return total;
}

function mapTotal(registry: Map<string, Map<string, number>>, key: string): number {
  let total = 0;
  for (const [name, value] of registry.get(key) ?? []) total += name.length + value;
  return total;
}

function stringLength(registry: Map<string, string>, key: string): number {
  let total = 0;
  for (const ch of registry.get(key) ?? []) total += ch.length;
  return total;
}

function main(): void {
  const sets = new Map<string, Set<string>>();
  sets.set("a", new Set(["xy", "z"]));
  console.log("set", setLength(sets, "a"), setLength(sets, "missing"));
  sets.get("a")?.add("q");
  console.log("set live", setLength(sets, "a"));

  const maps = new Map<string, Map<string, number>>();
  maps.set("a", new Map([["xy", 3]]));
  console.log("map", mapTotal(maps, "a"), mapTotal(maps, "missing"));

  const strings = new Map<string, string>();
  strings.set("a", "xyz");
  console.log("string", stringLength(strings, "a"), stringLength(strings, "missing"));

  // The same shape through an explicit union annotation.
  const empty: Set<string> | never[] = sets.get("missing") ?? [];
  let seen = 0;
  for (const item of empty) seen += item.length;
  console.log("annotated", seen);

  // The head runs once: a lookup with a side effect is called one time, and
  // the walk iterates the value the tag test saw.
  let calls = 0;
  const alternate = (): Set<string> | undefined => (++calls % 2 === 1 ? sets.get("a") : undefined);
  let walked = 0;
  for (const item of alternate() ?? []) walked += item.length;
  console.log("once", calls, walked);
  let mapCalls = 0;
  const mapLookup = (): Map<string, number> | undefined => {
    mapCalls++;
    return maps.get("a");
  };
  let mapWalked = 0;
  for (const [name, value] of mapLookup() ?? []) mapWalked += name.length + value;
  console.log("map once", mapCalls, mapWalked);
}
main();
