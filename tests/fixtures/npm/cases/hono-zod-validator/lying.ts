// Native-only (decl-boundary.test.ts): `c.req.valid()` is a checked
// boundary. z.custom checks nothing, so a body its declared type
// misdescribes fails the cast with a path TypeError, which hono's error
// handler reports; Node does not check. A union discriminated by boolean
// literals keeps both arms.
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";

const Liar = z.custom<{ n: number }>();
const Outcome = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), value: z.number() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);

const app = new Hono();
app.onError((err, c) => c.text(`${err instanceof TypeError} ${err.message}`, 500));
app.post("/liar", zValidator("json", Liar), (c) => c.text(String(c.req.valid("json").n + 1)));
app.post("/outcome", zValidator("json", Outcome), (c) => {
  const outcome = c.req.valid("json");
  return c.text(outcome.ok ? `value ${outcome.value + 1}` : `reason ${outcome.reason}`);
});

const requests: [string, unknown][] = [
  ["/liar", { n: 1 }],
  ["/liar", { n: "x" }],
  ["/outcome", { ok: true, value: 41 }],
  ["/outcome", { ok: false, reason: "late" }],
];

async function main(): Promise<void> {
  for (const [path, body] of requests) {
    const res = await app.request(path, {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    });
    console.log(path, res.status, await res.text());
  }
}

void main();
