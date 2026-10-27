// Functions as Map values, Map keys and Set elements: factory and listener
// registries keep each closure's identity, and a handler that captures its
// own registry is collected with it.

interface Extension {
  name: string;
  run(x: number): number;
}
type ExtensionFactory = (api: { log: (s: string) => void }) => Extension;
const factories = new Map<string, ExtensionFactory>();
factories.set("double", (api) => ({
  name: "double",
  run: (x) => {
    api.log("double " + x);
    return x * 2;
  },
}));
factories.set("inc", () => ({ name: "inc", run: (x) => x + 1 }));
const lines: string[] = [];
const api = { log: (s: string) => lines.push(s) };
for (const [key, make] of factories) {
  const ext = make(api);
  console.log(key, ext.name, ext.run(10));
}
console.log(factories.get("missing") === undefined, typeof factories.get("inc"), factories.has("inc"));
const inc = factories.get("inc");
if (inc) console.log(inc(api).run(41));
factories.delete("inc");
console.log([...factories.keys()].join(","), factories.size, lines.join(";"));

type Listener = (v: string) => void;
const listeners = new Set<Listener>();
const a: Listener = (v) => console.log("a", v);
const b: Listener = (v) => console.log("b", v);
listeners.add(a);
listeners.add(b);
listeners.add(a);
console.log(listeners.size, listeners.has(a), listeners.has((v) => console.log(v)));
for (const l of listeners) l("x");
listeners.delete(a);
listeners.forEach((l) => l("y"));

const counts = new Map<Listener, number>();
counts.set(a, 1);
counts.set(b, 2);
counts.set(a, 3);
console.log(counts.size, counts.get(a), counts.get(b));

const registry = new Map<string, () => number>();
registry.set("self", () => registry.size);
registry.set("double", () => registry.size * 2);
console.log([...registry.values()].map((f) => f()).join(","));
