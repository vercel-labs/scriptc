class Entry { value: number; constructor(value: number) { this.value = value; } }
class Cache<K, V> {
  entries = new Map<K, V>();
  get(key: K, fallback: V): V { return this.entries.get(key) ?? fallback; }
  read(key: K): V | undefined { return this.entries.get(key); }
}
function lookup<V>(cache: Cache<string, V>, key: string, fallback: V): V {
  return cache.get(key, fallback);
}
const objects = new Cache<string, Entry | undefined>();
const entry = new Entry(7);
objects.entries.set("present", entry);
objects.entries.set("empty", undefined);
console.log(lookup(objects, "present", undefined) === entry);
console.log(objects.read("missing"), lookup(objects, "empty", entry) === entry);
const scalars = new Cache<string, number | null | undefined>();
scalars.entries.set("zero", 0);
scalars.entries.set("null", null);
console.log(scalars.get("zero", 9), scalars.get("null", 9), scalars.get("missing", undefined));
type Variant = { kind: "value"; value: number } | { kind: "text"; text: string };
const variants = new Cache<string, Variant | undefined>();
variants.entries.set("a", { kind: "value", value: 3 });
variants.entries.set("b", { kind: "text", text: "ok" });
function format(value: Variant | undefined): string {
  if (value === undefined) return "missing";
  return value.kind === "value" ? String(value.value) : value.text;
}
console.log(format(variants.read("a")), format(variants.read("b")), format(variants.read("c")));
