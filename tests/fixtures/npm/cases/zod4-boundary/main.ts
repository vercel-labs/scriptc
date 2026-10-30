// Values that cross from zod 4.6 (compiled from its JavaScript) into code
// typed by zod's declarations: z.infer, z.input and z.output, identity,
// aliasing and mutation after parse, values zod hands back unchanged,
// callbacks zod calls, typed array work, and caught failures.
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
  note: z.string().optional(),
  owner: z.string().nullable(),
});
type Item = z.infer<typeof Item>;
const items: Item[] = z.array(Item).parse([
  { sku: "a", price: 2.5, qty: 4, tags: ["x"], owner: null },
  { sku: "b", price: 10, qty: 1, owner: "ann", note: "fragile" },
  { sku: "c", price: 0.5, qty: 10, tags: ["x", "y"], owner: null },
]);
const total = items.reduce((sum, it) => sum + it.price * it.qty, 0);
console.log("total", total);
const byTag = new Map<string, number>();
for (const it of items) for (const t of it.tags) byTag.set(t, (byTag.get(t) ?? 0) + it.qty);
console.log("byTag", [...byTag].map(([k, v]) => `${k}=${v}`).join(","));
const sorted = [...items].sort((a, b) => b.price - a.price).map((it) => it.sku);
console.log("sorted", sorted.join(","));
console.log("optional", items.map((it) => `${it.note ?? "-"}/${it.owner ?? "nobody"}`).join(","));
console.log("keys", items.map((it) => Object.keys(it).join("+")).join(" "));

// Mutation after parse is visible through every reference.
const first = items[0]!;
first.qty += 1;
first.tags.push("z");
console.log("mutated", items[0]!.qty, items[0]!.tags.join("|"), first === items[0]);
show("item", items[0]);

// Strict objects reject unknown keys; the error is zod's, caught.
const Strict = z.strictObject({ name: z.string().trim().min(1), email: z.email() });
type Strict = z.infer<typeof Strict>;
const person: Strict = Strict.parse({ name: "  Ada  ", email: "ada@example.com" });
console.log("strict", person.name.length, person.email.toUpperCase());
const rejected = Strict.safeParse({ name: "x", email: "x@example.com", extra: 1 });
console.log("strict bad", rejected.success, rejected.error?.issues.map((i) => i.code).join(","));

// z.input and z.output differ across a transform and a default.
const Config = z.object({
  port: z.string().transform((s) => Number(s)),
  host: z.string().default("localhost"),
  debug: z.enum(["true", "false"]).transform((v) => v === "true"),
});
type ConfigIn = z.input<typeof Config>;
type ConfigOut = z.output<typeof Config>;
const raw: ConfigIn = { port: "8080", debug: "true" };
const config: ConfigOut = Config.parse(raw);
console.log("config", config.port + 1, config.host, config.debug, typeof config.port);

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

// safeParse data, a discriminated union, and loose objects' extra keys.
const Event = z.discriminatedUnion("type", [
  z.object({ type: z.literal("click"), x: z.number(), y: z.number() }),
  z.object({ type: z.literal("key"), key: z.string() }),
]);
type Event = z.infer<typeof Event>;
const describe = (e: Event): string => (e.type === "click" ? `click@${e.x},${e.y}` : `key:${e.key}`);
const r = Event.safeParse({ type: "key", key: "Enter" });
if (r.success) console.log("event", describe(r.data));
const events = z.array(Event).parse([
  { type: "click", x: 1, y: 2 },
  { type: "key", key: "a" },
]);
console.log("events", events.map(describe).join(" "));
const Loose = z.looseObject({ id: z.number() });
const loose = Loose.parse({ extra: true, id: 3, more: "m" });
console.log("loose", loose.id, Object.keys(loose).join(","), JSON.stringify(loose));

// A union discriminated by boolean literals, read through a safeParse
// result narrowed to its success arm.
const Outcome = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.number() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
type Outcome = z.infer<typeof Outcome>;
const outcomes: Outcome[] = [];
for (const input of [{ ok: true, value: 41 }, { ok: false, reason: "late" }, { ok: "maybe" }]) {
  const parsed = Outcome.safeParse(input);
  if (parsed.success) outcomes.push(parsed.data);
  else console.log("outcome bad", parsed.error.issues.length);
}
console.log("outcomes", outcomes.map((o) => (o.ok ? `value ${o.value + 1}` : `reason ${o.reason}`)).join(", "));
const Flags = z.object({ beta: z.boolean().optional(), mode: z.enum(["a", "b"]) });
const flagged = Flags.safeParse({ beta: true, mode: "b" });
if (flagged.success) {
  const flags = flagged.data;
  console.log("flags", flags.beta === true ? "beta on" : "beta off", flags.mode);
}

// Tuples, brands and coerced query-style input.
const Pair = z.tuple([z.string(), z.number()]);
const [label, count] = Pair.parse(["n", 4]);
console.log("tuple", label, count + 1);
const UserId = z.string().brand<"UserId">();
const uid = UserId.parse("u_1");
console.log("brand", uid.length, uid);
const Query = z.object({ page: z.coerce.number().int().min(1).default(1), q: z.string().optional() });
const query = Query.parse({ page: "3" });
console.log("query", query.page * 10, query.q === undefined, "q" in query);

// async parse
async function main(): Promise<void> {
  const it = await Item.parseAsync({ sku: "d", price: 1, qty: 2, owner: null });
  console.log("async", it.sku, it.price * it.qty, it.tags.length);
  const failed = await Item.safeParseAsync({ sku: 1, price: -1, qty: 0.5, owner: null });
  console.log("async bad", failed.success, failed.error?.issues.map((i) => i.path.join(".")).join(","));
}

void main();
