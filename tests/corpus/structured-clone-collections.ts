// structuredClone of Maps and Sets, alone and in fields of typed records:
// keys and values are cloned, the copy is a new collection of the same
// type, and Dates, typed arrays and nested records in the same records
// clone too.
const m = new Map([
  ["a", 1],
  ["b", 2],
]);
const mc = structuredClone(m);
mc.set("c", 3);
console.log(mc.get("a"), mc.size, m.size, mc !== m, [...mc.keys()].join(","));
console.log(structuredClone({ m }).m.get("b"));

const s = new Set([1, 2, 3]);
const sc = structuredClone(s);
sc.delete(1);
console.log(sc.has(2), sc.size, s.size, [...sc].join(","));
console.log(structuredClone({ s }).s.has(3));

const d = new Date(86400000);
console.log(structuredClone({ d }).d.toISOString(), structuredClone(d).getTime());

const t = new Uint8Array([1, 2, 3]);
console.log(structuredClone({ t }).t[2], structuredClone(t).length);

// Record and array values are cloned, not shared.
type Item = { id: number; tags: string[] };
const items = new Map<string, Item>([["x", { id: 7, tags: ["red"] }]]);
const itemsCopy = structuredClone(items);
itemsCopy.get("x")!.tags.push("blue");
console.log(items.get("x")!.tags.join(","), itemsCopy.get("x")!.tags.join(","), itemsCopy.get("x")!.id);

// Number, boolean and string keys keep their types.
const byNumber = new Map<number, string>([
  [1, "one"],
  [-0, "zero"],
]);
const byNumberCopy = structuredClone(byNumber);
console.log(byNumberCopy.get(1), byNumberCopy.get(0), byNumberCopy.has(2));
const flags = new Set<boolean>([true]);
console.log(structuredClone(flags).has(true), structuredClone(flags).has(false));

// Collections nested in collections and records.
type Outer = { inner: { m: Map<string, number>; when: Date }; tags: Set<string>; bytes: Float64Array };
const outer: Outer = {
  inner: { m: new Map([["x", 5]]), when: new Date(0) },
  tags: new Set(["t"]),
  bytes: new Float64Array([1.5]),
};
const outerCopy = structuredClone(outer);
console.log(
  outerCopy.inner.m.get("x"),
  outerCopy.inner.when.getTime(),
  outerCopy.tags.has("t"),
  outerCopy.bytes[0],
  outerCopy.inner.m !== outer.inner.m,
);
const groups = new Map<string, Set<number>>([["evens", new Set([2, 4])]]);
const groupsCopy = structuredClone(groups);
groupsCopy.get("evens")!.add(6);
console.log(groups.get("evens")!.size, groupsCopy.get("evens")!.size);

// An empty collection, and an entry that cannot be cloned.
console.log(structuredClone(new Map<string, number>()).size, structuredClone(new Set<string>()).size);
const handlers = new Map<string, () => void>([["run", () => {}]]);
try {
  structuredClone(handlers);
  console.log("cloned");
} catch (error) {
  console.log((error as Error).name);
}
