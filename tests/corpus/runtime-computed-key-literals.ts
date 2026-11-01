// An object literal whose property name is decided at runtime writes that
// key where it stands: Node enumerates own keys in source order, so a
// computed key before a declared field comes first in JSON and in
// Object.keys, and a spread that joins the literal does not move it. The
// literal's inferred TypeScript type cannot describe such a key (a
// union-keyed computed property drops out of the inferred type once a
// spread joins the literal), so the value is built as a checked-dynamic
// object and validated into its destination.

type Rec = Record<string, unknown>;

// Computed key first / field first.
const computedFirst = (key: "a" | "b"): Rec => ({ [key]: 2, n: 1 });
const fieldFirst = (key: "a" | "b"): Rec => ({ n: 1, [key]: 2 });

// Two runtime keys, and a runtime key that overwrites an earlier field.
const twoKeys = (k1: "a" | "b", k2: "c" | "d"): Rec => ({ [k1]: 1, [k2]: 2 });
const overwrite = (key: "a" | "b"): Rec => ({ n: 1, [key]: 2, n2: 3 });

// An explicit index-signature interface destination keeps the same order.
interface ISig {
  [x: string]: unknown;
}
const isigFieldFirst = (key: "a" | "b"): ISig => ({ n: 1, [key]: 2 });
const isigComputedFirst = (key: "a" | "b"): ISig => ({ [key]: 2, n: 1 });

// A runtime key beside a spread: the key is written where it stands.
const withSpread = (key: "a" | "b", src: Rec): Rec => ({ [key]: 2, ...src });
const afterSpread = (key: "a" | "b", src: Rec): Rec => ({ ...src, [key]: 2 });

// The "one page of one server" shape (a runtime key, a declared field and
// a conditional spread deciding one more key), instantiated generically.
interface Item {
  id: string;
  _meta?: unknown;
}
interface Server {
  name: string;
  timeoutMs: number;
}

function tagged(server: string, item: Item): Rec {
  const { _meta: _m, ...rest } = item;
  return { server, ...rest };
}

const list = <T extends { _meta?: unknown }>(
  server: Server,
  key: "resources" | "resourceTemplates",
  items: T[],
  nextCursor: string | undefined,
  errors: string[],
): Rec => {
  if (nextCursor !== undefined || errors.length === 0) {
    return {
      server: server.name,
      [key]: items.map((item) => tagged(server.name, item as T & Item)),
      ...(nextCursor === undefined ? {} : { nextCursor }),
    };
  }
  const out: Rec[] = [];
  for (const item of items) out.push(tagged(server.name, item as T & Item));
  return { [key]: out, ...(errors.length > 0 ? { errors } : {}) };
};

const items: Item[] = [{ id: "a" }, { id: "b", _meta: { x: 1 } }];
const server: Server = { name: "svr", timeoutMs: 1 };

console.log(JSON.stringify(computedFirst("a")), JSON.stringify(fieldFirst("b")));
console.log(JSON.stringify(twoKeys("a", "c")), JSON.stringify(overwrite("b")));
console.log(JSON.stringify(isigFieldFirst("b")), JSON.stringify(isigComputedFirst("b")));
console.log(JSON.stringify(withSpread("a", { q: 1 })), JSON.stringify(afterSpread("b", { q: 1 })));

// Enumeration, not just stringification: own-key order for Object.keys,
// for-in, entries and a spread copy.
for (const value of [computedFirst("a"), isigComputedFirst("b"), overwrite("a")]) {
  const keys: string[] = [];
  for (const k in value) keys.push(String(k));
  console.log(Object.keys(value).join(","), keys.join(","), JSON.stringify(Object.entries(value)));
  console.log(JSON.stringify({ ...value }), Object.getOwnPropertyNames(value).join(","));
}
console.log(Object.keys(computedFirst("b")).join(","), computedFirst("a")["a"], computedFirst("a")["b"]);

// The runtime key's expression and every value evaluate in source order.
const trace: string[] = [];
function step<T>(label: string, value: T): T {
  trace.push(label);
  return value;
}
const keyed = (key: string): Rec => ({ [step(key, "k")]: step("v", 1), n: step("n", 2) });
console.log(JSON.stringify(keyed("first")), trace.join(","));

// Nested and generic instantiation of the list shape.
const one = list(server, "resources", items, "cur1", []);
console.log(JSON.stringify(one), Object.keys(one).join(","));
const two = list(server, "resourceTemplates", items, undefined, []);
console.log(JSON.stringify(two), Object.keys(two).join(","));
const three = list(server, "resources", items, undefined, ["boom"]);
console.log(JSON.stringify(three), Object.keys(three).join(","));
const four = list(server, "resources", [{ id: "c", _meta: "m" }], "c2", ["x"]);
console.log(JSON.stringify(four), Object.keys(four).join(","));
