// Object spreads over sources the record desugar cannot enumerate: an untyped
// (`unknown`) value and a runtime-keyed `Record<string, unknown>`. Node copies
// own enumerable keys in insertion order; the copy is validated into the
// declared record afterwards.
type Resource = { uri: string; name: string };
function toResource(item: Record<string, unknown>): Resource {
  return { ...item } as Resource;
}
const plain = toResource({ uri: "u", name: "n" });
console.log(JSON.stringify(plain));
const reordered = toResource({ name: "n2", uri: "u2" });
console.log(JSON.stringify(reordered), Object.keys(reordered).join(","));

function withDefault(item: Record<string, unknown>): Resource {
  return { ...item, name: item.name ?? item.uri } as Resource;
}
console.log(JSON.stringify(withDefault({ uri: "u3" })));
console.log(JSON.stringify(withDefault({ uri: "u4", name: "given" })));

// A typed record re-spread through an untyped hop keeps the same key order.
interface Full {
  uri: string;
  name: string;
  title: string;
}
function clone(item: Full): Full {
  const untyped = item as unknown as Record<string, unknown>;
  return { ...untyped } as unknown as Full;
}
const cloned = clone({ uri: "u5", name: "n5", title: "t5" });
console.log(JSON.stringify(cloned), Object.keys(cloned).join(","));

// A runtime-keyed base under explicit fields: the later explicit field wins,
// and the surviving keys stay in the order Node builds them.
interface Config {
  endpoint: string;
  retries: number;
}
function config(overrides: Record<string, unknown>): Config {
  return { ...overrides, endpoint: "https://example.test" } as Config;
}
const built = config({ retries: 3 });
console.log(JSON.stringify(built), Object.keys(built).join(","));

// An 'unknown' source merged with a typed one and a later override.
function merge(base: unknown, retries: number): Config {
  return { ...(base as Record<string, unknown>), retries } as Config;
}
const merged = merge({ endpoint: "https://merge.test" }, 5);
console.log(JSON.stringify(merged), Object.keys(merged).join(","));
