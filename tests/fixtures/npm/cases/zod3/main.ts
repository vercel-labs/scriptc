// zod 3.25 (the real package, trimmed to its v3 ESM build and types) compiled
// natively: schemas built at module top level, parse and safeParse across the
// common schema kinds, number checks, issue paths, codes and messages, and
// async refinements through parseAsync/safeParseAsync.
import { z } from "zod";

const show = (label: string, value: unknown): void => {
  console.log(label + " " + JSON.stringify(value));
};
const issues = (result: z.SafeParseReturnType<unknown, unknown>): string =>
  result.success
    ? "ok"
    : result.error.issues.map((i) => `${i.path.join(".")}:${i.code}:${i.message}`).join(" | ");

const Region = z.enum(["east", "west", "north"]);
const Job = z.object({
  id: z.string().min(3).max(32),
  region: Region,
  attempts: z.number().int().nonnegative().default(0),
  tags: z.record(z.string()).optional(),
  files: z.array(z.object({ path: z.string(), mode: z.number() })),
  kind: z.union([z.literal("static"), z.literal("worker")]),
  meta: z.object({ owner: z.string().nullable() }).partial(),
});
type Job = z.infer<typeof Job>;

const job: Job = Job.parse({
  id: "job_1",
  region: "east",
  files: [{ path: "a.js", mode: 420 }],
  kind: "worker",
  meta: { owner: null },
});
show("job", job);
show("bad job", issues(Job.safeParse({ id: "x", region: "south", files: [{ path: 1 }], kind: "edge" })));

// The common schema kinds.
show("number", z.number().parse(3));
show("default", z.number().default(0).parse(undefined));
show("optional", z.string().optional().parse(undefined) ?? "undefined");
show("nullable", z.string().nullable().parse(null));
show("record", z.record(z.string()).parse({ a: "b" }));
show("array", z.array(z.string()).parse(["a"]));
show("union", z.union([z.literal("a"), z.literal("b")]).parse("b"));
show("partial", z.object({ a: z.string() }).partial().parse({}));
show("discriminated", z.discriminatedUnion("t", [z.object({ t: z.literal("x") })]).parse({ t: "x" }));
show("transform", z.string().transform((s) => s.length).parse("abc"));
show("wrong type", issues(z.object({ a: z.number() }).safeParse({ a: "x" })));
show("email", issues(z.string().email().safeParse("nope")));
show("boolean", z.boolean().parse(true));
show("strict", issues(z.object({ a: z.string() }).strict().safeParse({ a: "x", b: 1 })));
show("regex", z.string().regex(/^a/).parse("abc"));
show("coerce", z.coerce.number().parse("4"));
show("extend", z.object({ a: z.string() }).extend({ b: z.number() }).parse({ a: "x", b: 1 }));
show("refine", issues(z.string().refine((s) => s.length > 1, "short").safeParse("a")));
show("enum", z.enum(["a", "b"]).parse("a"));
show("literal", z.literal("q").parse("q"));

// Number checks, passing and failing, with and without messages.
show("int", z.number().int().parse(3));
show("int fail", issues(z.number().int().safeParse(1.5)));
show("int message", issues(z.number().int("whole numbers only").safeParse(2.5)));
show("min", z.number().min(1).parse(3));
show("min fail", issues(z.number().min(1, "too low").safeParse(0)));
show("max fail", issues(z.number().max(10).safeParse(11)));
show("gt lt", issues(z.number().gt(0).lt(5).safeParse(5)));
show("positive", issues(z.number().positive().safeParse(0)));
show("nonnegative", issues(z.number().nonnegative().safeParse(-1)));
show("multipleOf", z.number().multipleOf(2).parse(4));
show("multipleOf fail", issues(z.number().multipleOf(0.1).safeParse(0.35)));
show("multipleOf float", z.number().multipleOf(0.01).parse(1.23));
show("step", issues(z.number().step(3).safeParse(10)));
show("finite", issues(z.number().finite().safeParse(Infinity)));
show("safe", issues(z.number().safe().safeParse(2 ** 60)));
show("bounds", [z.number().min(2).max(9).minValue, z.number().min(2).max(9).maxValue, z.number().int().isInt]);

try {
  Job.parse({});
} catch (error) {
  show("thrown", error instanceof z.ZodError ? error.issues.length : "other");
}

// Async refinements.
const Unique = z.string().refine(async (name) => name !== "taken", { message: "name is taken" });
const Account = z.object({
  name: Unique,
  age: z.number().int().min(18),
});

async function main(): Promise<void> {
  show("async ok", await Account.parseAsync({ name: "free", age: 30 }));
  show("async fail", issues(await Account.safeParseAsync({ name: "taken", age: 12.5 })));
  try {
    await Unique.parseAsync("taken");
  } catch (error) {
    show("async thrown", error instanceof z.ZodError ? error.issues[0]!.message : "other");
  }
  try {
    Unique.parse("free");
  } catch (error) {
    show("sync on async", (error as Error).message);
  }
  const Slow = z.number().superRefine(async (n, ctx) => {
    await new Promise((resolve) => setTimeout(resolve, 1));
    if (n % 2 !== 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "odd" });
  });
  show("superRefine", issues(await Slow.safeParseAsync(3)));
  show("transform async", await z.string().transform(async (s) => s.toUpperCase()).parseAsync("up"));
  show("array async", issues(await z.array(Unique).safeParseAsync(["a", "taken", "b"])));
  show("array async ok", await z.array(Unique).parseAsync(["x", "y"]));
  show("tuple async", issues(await z.tuple([z.string(), Unique]).safeParseAsync(["a", "taken"])));
  show("tuple async ok", await z.tuple([z.number(), Unique]).parseAsync([1, "z"]));
}

void main();
