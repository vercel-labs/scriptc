// @hono/zod-validator without a hook: a failed check answers 400 with the
// whole safeParse result serialized, so the ZodError's own enumerable
// properties (name, then message) and their order reach the client.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const Item = z.object({ title: z.string().min(2), qty: z.number().int().positive() });

const app = new Hono();
app.post("/items", zValidator("json", Item), (c) => {
  const item = c.req.valid("json");
  return c.json({ created: item.title, qty: item.qty }, 201);
});
app.get("/items", zValidator("query", z.object({ limit: z.coerce.number().int().max(5) })), (c) => {
  return c.json({ limit: c.req.valid("query").limit });
});

const post = (body: unknown) =>
  app.request("/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const show = async (label: string, res: Response | Promise<Response>) => {
  const r = await res;
  console.log(label, r.status, await r.text());
};

await show("ok", post({ title: "pen", qty: 2 }));
await show("bad-title", post({ title: "p", qty: 2 }));
await show("bad-both", post({ title: 3, qty: -1 }));
await show("query-ok", app.request("/items?limit=4"));
await show("query-bad", app.request("/items?limit=9"));

const result = Item.safeParse({ title: "x", qty: 0 });
if (!result.success) {
  const e = result.error;
  console.log(e.name, e instanceof Error, Object.keys(e).join(","));
  console.log(JSON.stringify(e));
}
