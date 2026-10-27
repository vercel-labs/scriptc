// zod 4's z.record and z.partialRecord accept only plain objects. Its check
// reads the value's constructor, that constructor's prototype, and whether
// the prototype has its own isPrototypeOf, so it needs Object.prototype's
// reflection to match Node.
import { z } from "zod";

const Scores = z.record(z.string(), z.number().int());
const Flags = z.record(z.enum(["a", "b"]), z.boolean());
const Partial = z.partialRecord(z.enum(["x", "y", "z"]), z.string());
const Nested = z.object({ name: z.string(), meta: z.record(z.string(), z.record(z.string(), z.number())) });

const show = (label: string, schema: z.ZodType, value: unknown): void => {
  const r = schema.safeParse(value);
  if (r.success) {
    console.log(label, "ok", JSON.stringify(r.data));
  } else {
    console.log(label, "fail", r.error.issues.map((i) => `${i.path.join(".")}:${i.code}:${i.message}`).join(" | "));
  }
};

show("scores", Scores, { alice: 3, bob: 7 });
show("scores-empty", Scores, {});
show("scores-bad-value", Scores, { alice: 1.5 });
show("scores-array", Scores, [1, 2]);
show("scores-null-proto", Scores, Object.assign(Object.create(null), { k: 1 }));
show("scores-parsed", Scores, JSON.parse('{"x":1,"y":2}'));
show("flags", Flags, { a: true, b: false });
show("flags-missing", Flags, { a: true });
show("flags-extra", Flags, { a: true, b: true, c: false });
show("partial", Partial, { y: "why" });
show("nested", Nested, { name: "n", meta: { one: { two: 2 } } });
show("nested-bad", Nested, { name: "n", meta: { one: [] } });

class Point {
  x = 1;
}
show("class-instance", Scores, new Point());
