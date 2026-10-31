// Localized failure, stage L3: push-down. A declared type that does not
// compile keeps its compilable shape; only the failing component is a
// checked dynamic piece.
type Hook = Map<string, (x: number) => string> | AbortSignal | (() => number) | Set<string>;

interface Plugin {
  name: string;
  priority: number;
  hook: Hook;
}

class Registry {
  plugins: Plugin[] = [];
  byName = new Map<string, Plugin>();
  pending: Promise<Plugin> | undefined;
  add(p: Plugin): void {
    this.plugins.push(p);
    this.byName.set(p.name, p);
  }
  total(): number {
    let sum = 0;
    for (const p of this.plugins) sum += p.priority;
    return sum;
  }
  names(): string {
    return this.plugins.map((p) => p.name).join(",");
  }
  run(name: string): string {
    const p = this.byName.get(name);
    if (p === undefined) return "missing";
    const h = p.hook;
    return typeof h === "function" ? `${p.name}=${h()}` : h instanceof Set ? `${p.name}#${h.size}` : "other";
  }
}

type Handler = (event: string, extra: Hook) => number;
function dispatch(handlers: Handler[], event: string): number {
  let n = 0;
  for (const h of handlers) n += h(event, () => event.length);
  return n;
}

const r = new Registry();
const counter: Plugin = { name: "counter", priority: 2, hook: () => 41 };
r.add(counter);
r.add({ name: "tags", priority: 5, hook: new Set(["a", "b"]) });
console.log(r.total(), r.names(), r.run("counter"), r.run("tags"), r.run("x"));
counter.priority = 10;
console.log(r.total(), r.byName.get("counter") === counter, JSON.stringify(r.plugins.map((p) => [p.name, p.priority])));
r.pending = Promise.resolve(counter);
r.pending.then((p) => console.log("pending", p.name, p === counter));
console.log(dispatch([(e, x) => e.length, (e, x) => (typeof x === "function" ? x() * 2 : 0)], "hello"));
