// A Proxy held by the binding it initializes, typed as an interface: every
// read, write, `in` and key listing goes through the traps, as in Node.
interface Config {
  depth: number;
  label: string;
}
const log: string[] = [];
const store: any = { depth: 1, label: "x" };

// `get` only, over an empty object asserted to the interface.
const doubled: Config = new Proxy({} as Config, {
  get(_target: any, key: string | symbol): any {
    return key === "depth" ? store.depth * 2 : store[key];
  },
});
console.log(doubled.depth, doubled.label);
store.depth = 5;
store.label = "y";
console.log(doubled.depth, doubled.label);

// `get`, `set`, `has` and `ownKeys`.
const traced: Config = new Proxy({ depth: 1, label: "x" } as any, {
  get(target: any, key: string | symbol): any {
    log.push("get " + String(key));
    return target[key];
  },
  set(target: any, key: string | symbol, value: any): boolean {
    log.push("set " + String(key));
    target[key] = value;
    return true;
  },
  has(target: any, key: string | symbol): boolean {
    log.push("has " + String(key));
    return key in target;
  },
  ownKeys(target: any): (string | symbol)[] {
    log.push("ownKeys");
    return Reflect.ownKeys(target);
  },
});
traced.depth = 7;
traced.depth += 1;
console.log(traced.depth, "label" in traced, Object.keys(traced).join(","));
console.log(log.join("|"));

// A binding inside a function holds the Proxy too, with `const` and `let`,
// and a closure reads through it.
function local(source: any): string {
  const view: Config = new Proxy(source, {
    get(target: any, key: string | symbol): any {
      return key === "depth" ? target.depth + 100 : target[key];
    },
  });
  const before = view.depth;
  source.depth = 2;
  const read = (): number => view.depth;
  let swapped: Config = new Proxy(source, {
    get(target: any, key: string | symbol): any {
      return key === "label" ? "<" + target.label + ">" : target[key];
    },
  });
  const label = swapped.label;
  swapped = { depth: 40, label: "plain" };
  return [before, read(), label, swapped.depth, swapped.label].join(" ");
}
console.log(local({ depth: 1, label: "z" }));

// A trap that throws, and a Proxy that is passed on untyped.
const guarded: Config = new Proxy({} as Config, {
  get(_target: any, key: string | symbol): any {
    throw new RangeError("no " + String(key));
  },
});
try {
  console.log(guarded.depth);
} catch (error) {
  console.log(error instanceof RangeError, (error as Error).message);
}
function describe(value: any): string {
  return value.depth + "/" + value.label;
}
console.log(describe(doubled), describe(traced));
