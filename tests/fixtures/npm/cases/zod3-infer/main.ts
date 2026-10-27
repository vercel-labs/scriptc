// Types derived from zod 3.25 schemas (z.infer, z.input, z.output) used as
// ordinary typed data: field reads, spreads, interfaces extending inferred
// types, unions and discriminated unions narrowed by their tags, arrays,
// optional and nullable fields, transforms and defaults, and .extend.
import { z } from "zod";

const show = (label: string, value: unknown): void => {
  console.log(label + " " + JSON.stringify(value));
};

// Objects, and interfaces that extend an inferred type.
const ProductInput = z.object({
  name: z.string().min(1),
  priceCents: z.number().int().nonnegative(),
  tags: z.array(z.string()).default([]),
});
type ProductInput = z.infer<typeof ProductInput>;
interface Product extends ProductInput {
  id: string;
}

function makeProduct(id: string, input: ProductInput): Product {
  return { id, ...input };
}
const parsed = ProductInput.parse({ name: "Keyboard", priceCents: 12900, tags: ["input"] });
const product = makeProduct("p1", parsed);
show("product", product);
console.log("name", product.name, "price", product.priceCents, "tags", product.tags.join("|"));
const products: Product[] = [product, makeProduct("p2", ProductInput.parse({ name: "Cable", priceCents: 900 }))];
console.log("tagged", products.filter((p) => p.tags.includes("input")).map((p) => p.name).join(","));
let total = 0;
for (const p of products) total += p.priceCents;
console.log("total", total);

// safeParse data spread into a record with more fields.
const OrderInput = z.object({
  productId: z.string(),
  quantity: z.coerce.number().int().min(1),
  email: z.string().email(),
});
type OrderInput = z.infer<typeof OrderInput>;
interface Order extends OrderInput {
  id: string;
  totalCents: number;
}
function placeOrder(raw: unknown): Order | string {
  const result = OrderInput.safeParse(raw);
  if (!result.success) return result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
  return { id: "o1", ...result.data, totalCents: result.data.quantity * 4900 };
}
show("order", placeOrder({ productId: "p2", quantity: "3", email: "a@b.co" }));
show("bad order", placeOrder({ productId: "p2", quantity: "0", email: "nope" }));

// Optional and nullable fields.
const Profile = z.object({
  handle: z.string(),
  bio: z.string().optional(),
  avatar: z.string().nullable(),
  age: z.number().optional().nullable(),
});
type Profile = z.infer<typeof Profile>;
function describe(p: Profile): string {
  const bio = p.bio ?? "(no bio)";
  const avatar = p.avatar === null ? "(no avatar)" : p.avatar;
  const age = p.age == null ? "?" : String(p.age);
  return `${p.handle}: ${bio}, ${avatar}, ${age}`;
}
console.log(describe(Profile.parse({ handle: "ada", avatar: null })));
console.log(describe(Profile.parse({ handle: "bob", bio: "hi", avatar: "b.png", age: 42 })));

// Unions and discriminated unions narrowed by their tag.
const Shape = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("circle"), radius: z.number() }),
  z.object({ kind: z.literal("rect"), width: z.number(), height: z.number() }),
]);
type Shape = z.infer<typeof Shape>;
function area(s: Shape): number {
  switch (s.kind) {
    case "circle":
      return Math.round(Math.PI * s.radius * s.radius);
    case "rect":
      return s.width * s.height;
  }
}
const shapes: Shape[] = z.array(Shape).parse([
  { kind: "circle", radius: 2 },
  { kind: "rect", width: 3, height: 4 },
]);
console.log("areas", shapes.map(area).join(","));

const IdOrName = z.union([z.number(), z.string()]);
type IdOrName = z.infer<typeof IdOrName>;
const label = (v: IdOrName): string => (typeof v === "number" ? `#${v}` : v.toUpperCase());
console.log("labels", [IdOrName.parse(7), IdOrName.parse("x")].map(label).join(","));

// Transforms and defaults: input and output types differ.
const Settings = z.object({
  port: z.string().transform((s) => Number(s)),
  mode: z.enum(["dev", "prod"]).default("dev"),
});
type SettingsIn = z.input<typeof Settings>;
type SettingsOut = z.output<typeof Settings>;
const rawSettings: SettingsIn = { port: "8080" };
const settings: SettingsOut = Settings.parse(rawSettings);
console.log("settings", settings.port + 1, settings.mode, typeof settings.port, rawSettings.port.length);

// .extend and arrays of inferred records.
const Base = z.object({ id: z.string(), createdAt: z.string() });
const User = Base.extend({ email: z.string().email(), roles: z.array(z.enum(["admin", "user"])) });
type User = z.infer<typeof User>;
const users: User[] = z.array(User).parse([
  { id: "u1", createdAt: "2026-01-01", email: "a@b.co", roles: ["admin", "user"] },
  { id: "u2", createdAt: "2026-01-02", email: "c@d.co", roles: ["user"] },
]);
const admins = users.filter((u) => u.roles.includes("admin")).map((u) => `${u.id}<${u.email}>`);
console.log("admins", admins.join(","));
const renamed = users.map((u) => ({ ...u, id: u.id.toUpperCase() }));
show("renamed", renamed);
