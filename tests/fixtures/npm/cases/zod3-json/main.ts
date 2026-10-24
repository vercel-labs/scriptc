// zod 3 schemas parsing JSON text: the speculative JSON shape built from
// the schema, and every input that falls back to zod (wrong types, failed
// refinements, extra, missing, reordered and duplicate keys, `__proto__`,
// syntax errors). Output objects carry the schema's keys in schema order.
import { z } from "zod";

const Item = z.object({ sku: z.string(), qty: z.number().int(), price: z.number() });
const Order = z.object({
  id: z.number().int(),
  note: z.string().optional(),
  kind: z.literal("order"),
  region: z.enum(["eu", "us"]),
  items: z.array(Item),
  rush: z.boolean(),
  coupon: z.string().nullable(),
  tags: z.array(z.string()).optional(),
  ship: z.object({ city: z.string(), zip: z.string().nullable() }).nullable().optional(),
});
const Orders = z.array(Order);
const Point = z.object({ x: z.number(), y: z.number() });

function show(label: string, text: string): void {
  try {
    const orders = Orders.parse(JSON.parse(text));
    console.log(label, JSON.stringify(orders), orders.length);
  } catch (e) {
    const err = e as Error;
    // (Syntax error messages are V8's wording; the name is the contract.)
    const message = err.name === "SyntaxError" ? "" : err.message.split("\n").slice(0, 8).join(" ");
    console.log(label, "error", err.name, message);
  }
}

const good = {
  id: 1,
  kind: "order",
  region: "eu",
  items: [{ sku: "a", qty: 2, price: 1.5 }],
  rush: false,
  coupon: null,
};
show("plain", JSON.stringify([good]));
show("optional set", JSON.stringify([{ ...good, note: "n", tags: ["x", "y"], ship: { city: "c", zip: null } }]));
show("ship null", JSON.stringify([{ ...good, ship: null }]));
show("empty", "[]");
show("reordered", '[{"rush":true,"items":[],"region":"us","kind":"order","id":7,"coupon":"c","note":"late"}]');
show("extra key", JSON.stringify([{ ...good, extra: { deep: [1] } }]));
show("proto key", '[{"__proto__":{"rush":1},"id":2,"kind":"order","region":"eu","items":[],"rush":true,"coupon":null}]');
show("duplicate", '[{"id":1,"id":3,"kind":"order","region":"eu","items":[],"rush":true,"coupon":null}]');
show("float id", JSON.stringify([{ ...good, id: 1.5 }]));
show("bad enum", JSON.stringify([{ ...good, region: "apac" }]));
show("bad literal", JSON.stringify([{ ...good, kind: "refund" }]));
show("wrong type", JSON.stringify([{ ...good, rush: "yes" }]));
show("missing", JSON.stringify([{ id: 1 }]));
show("null optional", JSON.stringify([{ ...good, note: null }]));
show("item qty", JSON.stringify([{ ...good, items: [{ sku: "a", qty: 0.5, price: 1 }] }]));
show("not array", JSON.stringify(good));
show("syntax", "[{");
show("big number", '[{"id":1e400,"kind":"order","region":"eu","items":[],"rush":true,"coupon":null}]');
show("unicode", JSON.stringify([{ ...good, coupon: "é😀", note: " " }]));

// The parsed output is ordinary data the program goes on to use.
const parsed = Orders.parse(JSON.parse(JSON.stringify([good, { ...good, id: 2, note: "x" }])));
let total = 0;
for (const o of parsed) for (const it of o.items) total += it.qty * it.price;
console.log("total", total, parsed[1]!.note ?? "none", Object.keys(parsed[0]!).join(","));

// Point and a loop: many parses of one schema.
let sum = 0;
for (let i = 0; i < 200; i++) {
  const text = i % 50 === 0 ? `{"x":${i},"y":"bad"}` : `{"y":${i},"x":${i / 2}}`;
  try {
    const p = Point.parse(JSON.parse(text));
    sum += p.x + p.y;
  } catch {
    sum -= 1;
  }
}
console.log("points", sum);
