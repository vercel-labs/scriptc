import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { compile, deserializeModule } from "../src/index.js";

/** What the lowered module holds of the kept-source machinery: the
 * `record.sourceHas` tests, the live checked views (`dynFrom` with
 * `liveRef`), and whether the frontend removed the tests. */
async function lowered(
  source: string,
): Promise<{ tests: number; liveViews: number; folded: boolean; dynamicFunctions: number }> {
  const dir = await mkdtemp(join(tmpdir(), "scriptc-source-fold-"));
  try {
    const entry = join(dir, "main.ts");
    await writeFile(entry, `${source}\nexport {};\n`);
    const outPath = join(dir, "main.ir.json");
    const result = await compile(entry, { outDir: dir, outPath, outputKind: "ir" });
    if (!result.ok)
      throw new Error(result.diagnostics.map((d) => `${d.code}: ${d.message}`).join("\n"));
    const mod = deserializeModule(await readFile(outPath, "utf8"));
    let tests = 0;
    let liveViews = 0;
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) visit(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      const node = value as { kind?: unknown; fn?: unknown; liveRef?: unknown };
      if (node.kind === "libCall" && node.fn === "record.sourceHas") tests++;
      if (node.kind === "dynFrom" && node.liveRef === true) liveViews++;
      for (const child of Object.values(value)) visit(child);
    };
    visit(mod.functions);
    return {
      tests,
      liveViews,
      folded: mod.recordSourcesFolded !== undefined,
      dynamicFunctions: mod.functions.filter((fn) => fn.tier === "dynamic").length,
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const REC = `type Rec = { a: number; b: string };
`;
/** Every reflective surface of a closed record. */
const SURFACES = `function surfaces(r: Rec): string {
  const seen: string[] = [];
  for (const key in r) seen.push(key);
  return [
    Object.keys(r).join(","),
    Object.values(r).join(","),
    Object.entries(r).length,
    seen.join(","),
    JSON.stringify(r),
    Object.getOwnPropertyNames(r).join(","),
    "a" in r,
    Object.hasOwn(r, "b"),
    Object.prototype.hasOwnProperty.call(r, "a"),
    r.hasOwnProperty("b"),
    String(r),
  ].join("|");
}
`;

test("a typed program's reflective surfaces hold no source test and no checked view", async () => {
  const typed = await lowered(`${REC}${SURFACES}console.log(surfaces({ a: 1, b: "x" }));
console.log({ a: 2, b: "y" });`);
  expect(typed).toEqual({ tests: 0, liveViews: 0, folded: true, dynamicFunctions: 0 });
});

test("values that are closed records do not make their holder's surfaces keep the test", async () => {
  // Object.values of the holder converts the view's answer back into
  // Rec[], behind the holder's own source test.
  const nested = await lowered(`${REC}type Holder = { first: Rec; second: Rec };
const h: Holder = { first: { a: 1, b: "x" }, second: { a: 2, b: "y" } };
for (const r of Object.values(h)) console.log(Object.keys(r).join(","));
for (const [name, r] of Object.entries(h)) console.log(name, r.a);`);
  expect(nested).toEqual({ tests: 0, liveViews: 0, folded: true, dynamicFunctions: 0 });
});

/** Programs in which a record can come to hold an undeclared key: the tests
 * stay. Each names the one way in. */
const KEEPING: [string, string][] = [
  [
    "a checked conversion",
    `const r = JSON.parse('{"a":1,"b":"x","extra":2}') as Rec;
console.log(surfaces(r));`,
  ],
  [
    "a typed function called through an untyped reference",
    `const call: any = surfaces;
console.log(call({ a: 1, b: "x", extra: 2 }));`,
  ],
  [
    "a typed callback handed to an untyped array",
    `const loose: any = [{ a: 1, b: "x", extra: 2 }];
loose.forEach((r: Rec) => console.log(surfaces(r)));`,
  ],
  [
    "an element pushed through an untyped view of a typed array",
    `const list: Rec[] = [];
const view: any = list;
view.push({ a: 1, b: "x", extra: 2 });
for (const r of list) console.log(surfaces(r));`,
  ],
  [
    "an entry set through an untyped view of a typed map",
    `const byName = new Map<string, Rec>();
const view: any = byName;
view.set("k", { a: 1, b: "x", extra: 2 });
console.log(surfaces(byName.get("k")!));`,
  ],
  [
    "a field written through an untyped view of its holder",
    `const holder: { inner: Rec; n: number } = { inner: { a: 1, b: "x" }, n: 1 };
const view: any = holder;
view.inner = { a: 2, b: "y", extra: 3 };
console.log(surfaces(holder.inner));`,
  ],
  [
    "a class instance handed to untyped code",
    `class Box {
  inner: Rec = { a: 1, b: "x" };
}
const box = new Box();
const view: any = box;
view.inner = { a: 2, b: "y", extra: 3 };
console.log(surfaces(box.inner));`,
  ],
  [
    "a promise settled by untyped code",
    `const make: any = () => Promise.resolve({ a: 1, b: "x", extra: 2 });
const pending: Promise<Rec> = make();
void pending.then((r) => console.log(surfaces(r)));`,
  ],
  [
    "a message from another process",
    `process.on("message", (r: Rec) => console.log(surfaces(r)));`,
  ],
  [
    "a record read by a computed key",
    `const holder: { inner: Rec; other: Rec } = { inner: { a: 1, b: "x" }, other: { a: 2, b: "y" } };
function pick(key: string): unknown {
  return (holder as Record<string, unknown>)[key];
}
const picked: any = pick("inner");
picked.extra = 1;
console.log(surfaces(holder.inner));`,
  ],
];

test.each(KEEPING)("%s keeps the source tests", async (_name, body) => {
  const kept = await lowered(`${REC}${SURFACES}${body}`);
  expect(kept.folded).toBe(false);
  expect(kept.tests).toBeGreaterThan(0);
  expect(kept.liveViews).toBeGreaterThan(0);
});
