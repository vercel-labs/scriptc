// Values that cross from zod 3.25 (compiled from its JavaScript) into code
// typed by zod's declarations: identity, aliasing and mutation after parse,
// values zod hands back unchanged, callbacks zod calls, typed array work,
// and failing checks.
import { z } from "zod";

const show = (label: string, value: unknown): void => {
  console.log(label + " " + JSON.stringify(value));
};

// Typed records: field reads, writes and array work on parsed data.
const Item = z.object({
  sku: z.string(),
  price: z.number().nonnegative(),
  qty: z.number().int(),
  tags: z.array(z.string()).default([]),
});
type Item = z.infer<typeof Item>;
const items: Item[] = z.array(Item).parse([
  { sku: "a", price: 2.5, qty: 4, tags: ["x"] },
  { sku: "b", price: 10, qty: 1 },
  { sku: "c", price: 0.5, qty: 10, tags: ["x", "y"] },
]);
const total = items.reduce((sum, it) => sum + it.price * it.qty, 0);
console.log("total", total);
const byTag = new Map<string, number>();
for (const it of items) for (const t of it.tags) byTag.set(t, (byTag.get(t) ?? 0) + it.qty);
console.log("byTag", [...byTag].map(([k, v]) => `${k}=${v}`).join(","));
const sorted = [...items].sort((a, b) => b.price - a.price).map((it) => it.sku);
console.log("sorted", sorted.join(","));

// Mutation after parse is visible through every reference.
const first = items[0]!;
first.qty += 1;
first.tags.push("z");
console.log("mutated", items[0]!.qty, items[0]!.tags.join("|"), first === items[0]);
show("item", items[0]);

// A value zod hands back unchanged keeps its identity and its mutations.
const Point = z.custom<{ x: number; y: number }>();
const original = { x: 1, y: 2 };
const same = Point.parse(original);
same.x = 10;
console.log("custom", original.x, same === original);
original.y = 20;
console.log("custom back", same.y);

// A shared object returned by a transform: every parse sees the same one.
const shared = { hits: 0 };
const Counter = z.string().transform(() => shared);
const c1 = Counter.parse("a");
const c2 = Counter.parse("b");
c1.hits += 1;
console.log("shared", c2.hits, shared.hits, c1 === c2);

// A refine callback reads typed fields of the value zod checks.
const Range = z
  .object({ lo: z.number(), hi: z.number() })
  .refine((r) => r.lo <= r.hi, { message: "lo must not exceed hi" });
console.log("range ok", JSON.stringify(Range.parse({ lo: 1, hi: 3 })));
const bad = Range.safeParse({ lo: 5, hi: 3 });
console.log("range bad", bad.success ? "?" : bad.error.issues[0]?.message);

// safeParse data, a discriminated union, and passthrough keys.
const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("key"), key: z.string() }),
]);
type Event = z.infer<typeof Event>;
const describe = (e: Event): string => (e.type === "click" ? `click@${e.x},${e.y}` : `key:${e.key}`);
const r = Event.safeParse({ type: "key", key: "Enter" });
if (r.success) console.log("event", describe(r.data));
const Loose = z.object({ id: z.number() }).passthrough();
const loose = Loose.parse({ extra: true, id: 3, more: "m" });
console.log("loose", loose.id, Object.keys(loose).join(","), JSON.stringify(loose));

// async parse
async function main(): Promise<void> {
  const it = await Item.parseAsync({ sku: "d", price: 1, qty: 2 });
  console.log("async", it.sku, it.price * it.qty, it.tags.length);
}

void main();
